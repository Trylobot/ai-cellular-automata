const GRID_SIZE = 256;
const WORKGROUP_SIZE = 8;

async function init() {
    if (!navigator.gpu) {
        alert("WebGPU not supported on this browser.");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        alert("No appropriate GPUAdapter found.");
        return;
    }

    const device = await adapter.requestDevice();

    const canvas = document.getElementById("gpuCanvas");
    const context = canvas.getContext("webgpu");
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
        device: device,
        format: presentationFormat,
        alphaMode: "premultiplied",
    });

    const shaderModule = device.createShaderModule({
        label: "Cellular Automata Shaders",
        code: await (await fetch("./shaders.wgsl")).text(),
    });

    // --- Compute Pipeline ---
    const computePipeline = device.createComputePipeline({
        label: "Compute Pipeline",
        layout: "auto",
        compute: {
            module: shaderModule,
            entryPoint: "computeMain",
        },
    });

    // --- Render Pipeline ---
    const renderPipeline = device.createRenderPipeline({
        label: "Render Pipeline",
        layout: "auto",
        vertex: {
            module: shaderModule,
            entryPoint: "vertexMain",
        },
        fragment: {
            module: shaderModule,
            entryPoint: "fragmentMain",
            targets: [{ format: presentationFormat }],
        },
        primitive: {
            topology: "triangle-list",
        },
    });

    // --- Textures & Buffers ---
    // Use r32float because rgba8unorm is often not storage-capable
    const textureDesc = {
        size: [GRID_SIZE, GRID_SIZE],
        format: "r32float",
        usage: GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.COPY_DST,
    };

    const textureA = device.createTexture(textureDesc);
    const textureB = device.createTexture(textureDesc);

    // --- Time Buffer ---
    const timeBuffer = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- Palette Buffer ---
    // struct Palette { bg: vec4<f32>, fg: vec4<f32>, chaos: vec4<f32> }
    // Size: 4 * 4 * 3 = 48 bytes
    const paletteBufferSize = 48;
    const paletteBuffer = device.createBuffer({
        size: paletteBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    function hexToRgb(hex) {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return [r, g, b, 1.0];
    }

    function updatePalette(bgHex, fgHex, chaosHex) {
        const bg = hexToRgb(bgHex);
        const fg = hexToRgb(fgHex);
        const chaos = hexToRgb(chaosHex);
        const data = new Float32Array([...bg, ...fg, ...chaos]);
        device.queue.writeBuffer(paletteBuffer, 0, data);
    }

    // Initial Palette (System Default)
    updatePalette("#29AE93", "#00FFCC", "#FFA500");

    // --- Sampler for rendering ---
    const sampler = device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
    });

    // --- Bind Groups ---
    const computeBindGroupA = device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 1, resource: textureA.createView() },
            { binding: 2, resource: textureB.createView() },
            { binding: 3, resource: { buffer: timeBuffer } },
        ],
    });

    const computeBindGroupB = device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 1, resource: textureB.createView() },
            { binding: 2, resource: textureA.createView() },
            { binding: 3, resource: { buffer: timeBuffer } },
        ],
    });

    // We need two bind groups for rendering (Read A or Read B)
    const renderBindGroupA = device.createBindGroup({
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paletteBuffer } },
            { binding: 3, resource: textureA.createView() },
        ],
    });

    const renderBindGroupB = device.createBindGroup({
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paletteBuffer } },
            { binding: 3, resource: textureB.createView() },
        ],
    });

    // --- UI Elements ---
    const fpsElem = document.getElementById("fps");
    const genElem = document.getElementById("generation");
    const playPauseBtn = document.getElementById("playPauseBtn");
    const randomSoupBtn = document.getElementById("randomSoupBtn");
    const crossBtn = document.getElementById("crossBtn");
    const dotBtn = document.getElementById("dotBtn");
    const yinYangBtn = document.getElementById("yinYangBtn");
    const fpsCapInput = document.getElementById("fpsCap");
    const toggleMenuBtn = document.getElementById("toggleMenuBtn");
    const overlay = document.getElementById("overlay");

    const colorBgInput = document.getElementById("colorBg");
    const colorFgInput = document.getElementById("colorFg");
    const colorChaosInput = document.getElementById("colorChaos");
    const systemPresetBtn = document.getElementById("systemPresetBtn");

    // --- State ---
    let frameCount = 0;
    let lastTime = performance.now();
    let generation = 0;
    let useTextureA = true; // Input texture is A, Output is B
    let isPlaying = false;
    let fpsInterval = 1000 / 12; // Default 12 FPS
    let then = performance.now();

    // --- Initialization ---
    // Start Blank
    const blankData = new Float32Array(GRID_SIZE * GRID_SIZE);
    blankData.fill(0.0);

    function uploadData(data) {
        device.queue.writeTexture(
            { texture: textureA },
            data,
            { bytesPerRow: GRID_SIZE * 4 },
            { width: GRID_SIZE, height: GRID_SIZE }
        );
        // Also clear textureB to avoid artifacts if we switch before compute
        device.queue.writeTexture(
            { texture: textureB },
            data,
            { bytesPerRow: GRID_SIZE * 4 },
            { width: GRID_SIZE, height: GRID_SIZE }
        );
        // Reset generation
        generation = 0;
        genElem.textContent = `Gen: ${generation}`;
        // Reset to use Texture A as input
        useTextureA = true;
    }

    uploadData(blankData);

    // --- Event Listeners ---
    playPauseBtn.addEventListener("click", () => {
        isPlaying = !isPlaying;
        playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
    });

    randomSoupBtn.addEventListener("click", () => {
        const data = new Float32Array(GRID_SIZE * GRID_SIZE);
        for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
            data[i] = Math.random() > 0.5 ? 1.0 : 0.0;
        }
        uploadData(data);
    });

    crossBtn.addEventListener("click", () => {
        const data = new Float32Array(GRID_SIZE * GRID_SIZE);
        data.fill(0.0);
        const mid = Math.floor(GRID_SIZE / 2);
        for (let i = 0; i < GRID_SIZE; i++) {
            data[mid * GRID_SIZE + i] = 2.0; // Horizontal
            data[i * GRID_SIZE + mid] = 2.0; // Vertical
        }
        uploadData(data);
    });

    dotBtn.addEventListener("click", () => {
        const data = new Float32Array(GRID_SIZE * GRID_SIZE);
        data.fill(0.0);
        const mid = Math.floor(GRID_SIZE / 2);
        const r = 2; // 5x5 center means radius 2
        for (let y = mid - r; y <= mid + r; y++) {
            for (let x = mid - r; x <= mid + r; x++) {
                data[y * GRID_SIZE + x] = 2.0;
            }
        }
        uploadData(data);
    });

    yinYangBtn.addEventListener("click", () => {
        const data = new Float32Array(GRID_SIZE * GRID_SIZE);
        const mid = GRID_SIZE / 2;
        const R = GRID_SIZE / 3;
        const r_dot = R / 5; // Size of the small dots

        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                const dx = x - mid;
                const dy = y - mid;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > R) {
                    data[y * GRID_SIZE + x] = 2.0; // Chaos outside
                    continue;
                }

                // Distances to centers of the two semi-circles/dots
                // Top center (for negative dy)
                const d_top = Math.sqrt(dx * dx + (dy + R / 2) ** 2);
                // Bottom center (for positive dy)
                const d_bot = Math.sqrt(dx * dx + (dy - R / 2) ** 2);

                // Logic for Yin-Yang
                // 1. Small dots (highest priority)
                if (d_top < r_dot) {
                    data[y * GRID_SIZE + x] = 1.0; // Alive dot in Dead section
                } else if (d_bot < r_dot) {
                    data[y * GRID_SIZE + x] = 0.0; // Dead dot in Alive section
                }
                // 2. Large semi-circles (create the S-curve)
                else if (d_top < R / 2) {
                    data[y * GRID_SIZE + x] = 0.0; // Dead bulge
                } else if (d_bot < R / 2) {
                    data[y * GRID_SIZE + x] = 1.0; // Alive bulge
                }
                // 3. Base halves
                else if (dx > 0) {
                    data[y * GRID_SIZE + x] = 1.0; // Right is Alive
                } else {
                    data[y * GRID_SIZE + x] = 0.0; // Left is Dead
                }
            }
        }
        uploadData(data);
    });

    fpsCapInput.addEventListener("change", (e) => {
        let val = parseInt(e.target.value);
        if (val < 1) val = 1;
        if (val > 144) val = 144;
        fpsInterval = 1000 / val;
    });

    toggleMenuBtn.addEventListener("click", () => {
        overlay.classList.toggle("collapsed");
        toggleMenuBtn.textContent = overlay.classList.contains("collapsed") ? "+" : "−";
    });

    function handleColorChange() {
        updatePalette(colorBgInput.value, colorFgInput.value, colorChaosInput.value);
    }

    colorBgInput.addEventListener("input", handleColorChange);
    colorFgInput.addEventListener("input", handleColorChange);
    colorChaosInput.addEventListener("input", handleColorChange);

    systemPresetBtn.addEventListener("click", () => {
        colorBgInput.value = "#29AE93";
        colorFgInput.value = "#00FFCC";
        colorChaosInput.value = "#FFA500";
        updatePalette("#29AE93", "#00FFCC", "#FFA500");
    });

    // --- Resize Handling ---
    function resize() {
        const displayWidth = canvas.clientWidth;
        const displayHeight = canvas.clientHeight;

        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth;
            canvas.height = displayHeight;
        }
    }
    window.addEventListener('resize', resize);
    resize();

    // --- Simulation Loop ---
    function frame() {
        requestAnimationFrame(frame);

        const now = performance.now();
        const elapsed = now - then;

        // Update Time Uniform
        device.queue.writeBuffer(timeBuffer, 0, new Float32Array([now / 1000.0]));

        // FPS Counter update (independent of cap)
        if (now - lastTime >= 1000) {
            fpsElem.textContent = `FPS: ${frameCount}`;
            frameCount = 0;
            lastTime = now;
        }

        // FPS Cap Logic
        if (isPlaying && elapsed < fpsInterval) {
            // Skip frame update if too fast
        } else {
            if (isPlaying) {
                then = now - (elapsed % fpsInterval);
                generation++;
                genElem.textContent = `Gen: ${generation}`;
                frameCount++; // Count simulated frames
            }

            const commandEncoder = device.createCommandEncoder();

            if (isPlaying) {
                // 1. Compute Pass
                const computePass = commandEncoder.beginComputePass();
                computePass.setPipeline(computePipeline);
                computePass.setBindGroup(0, useTextureA ? computeBindGroupA : computeBindGroupB);
                computePass.dispatchWorkgroups(Math.ceil(GRID_SIZE / WORKGROUP_SIZE), Math.ceil(GRID_SIZE / WORKGROUP_SIZE));
                computePass.end();
            }

            // 2. Render Pass
            const textureView = context.getCurrentTexture().createView();
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 }, // Clear to black, shader handles bg
                    loadOp: "clear",
                    storeOp: "store",
                }],
            });
            renderPass.setPipeline(renderPipeline);

            let textureToRender;
            if (isPlaying) {
                textureToRender = useTextureA ? renderBindGroupB : renderBindGroupA;
            } else {
                textureToRender = useTextureA ? renderBindGroupA : renderBindGroupB;
            }

            renderPass.setBindGroup(0, textureToRender);
            renderPass.draw(6);
            renderPass.end();

            device.queue.submit([commandEncoder.finish()]);

            if (isPlaying) {
                useTextureA = !useTextureA;
            }
        }
    }

    requestAnimationFrame(frame);
}

init();
