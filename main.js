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
    const paletteBufferSize = 80;
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

    function updatePalette(bgHex, fgHex, chaosHex, alwaysDeadHex, alwaysAliveHex) {
        const bg = hexToRgb(bgHex);
        const fg = hexToRgb(fgHex);
        const chaos = hexToRgb(chaosHex);
        const alwaysDead = hexToRgb(alwaysDeadHex);
        const alwaysAlive = hexToRgb(alwaysAliveHex);
        const data = new Float32Array([...bg, ...fg, ...chaos, ...alwaysDead, ...alwaysAlive]);
        device.queue.writeBuffer(paletteBuffer, 0, data);
    }

    // Initial Palette (System Default)
    updatePalette("#29AE93", "#00FFCC", "#FFA500", "#003300", "#CCFFCC");

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

    // --- Patterns ---
    const patterns = [
        {
            name: "Glider",
            w: 3, h: 3,
            data: [
                0, 1, 0,
                0, 0, 1,
                1, 1, 1
            ]
        },
        {
            name: "LWSS",
            w: 5, h: 4,
            data: [
                0, 1, 1, 1, 1,
                1, 0, 0, 0, 1,
                0, 0, 0, 0, 1,
                1, 0, 0, 1, 0
            ]
        },
        {
            name: "Block",
            w: 2, h: 2,
            data: [
                1, 1,
                1, 1
            ]
        },
        {
            name: "Rocket (Placeholder)",
            w: 5, h: 5,
            data: [
                0, 0, 1, 0, 0,
                0, 1, 1, 1, 0,
                1, 0, 1, 0, 1,
                0, 1, 1, 1, 0,
                0, 1, 0, 1, 0
            ]
        }
    ];

    // --- Stamp Tool State ---
    let isStampActive = false;
    let currentPatternIndex = 0;
    let mouseX = 0;
    let mouseY = 0;

    // --- Stamp Tool UI ---
    const stampToggleBtn = document.getElementById("stampToggleBtn");
    const stampControls = document.getElementById("stampControls");
    const patternGrid = document.getElementById("patternGrid");
    const overlayCanvas = document.getElementById("overlayCanvas");
    const overlayCtx = overlayCanvas.getContext("2d");

    // --- Stamp Shader Bindings ---
    const stampPipeline = device.createComputePipeline({
        label: "Stamp Pipeline",
        layout: "auto",
        compute: {
            module: shaderModule,
            entryPoint: "stampMain",
        },
    });

    const stampUniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const patternDataBuffer = device.createBuffer({
        size: 1024,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const stampBindGroupA = device.createBindGroup({
        layout: stampPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 1, resource: textureA.createView() },
            { binding: 2, resource: textureB.createView() },
            { binding: 4, resource: { buffer: stampUniformBuffer } },
            { binding: 5, resource: { buffer: patternDataBuffer } },
        ],
    });

    const stampBindGroupB = device.createBindGroup({
        layout: stampPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 1, resource: textureB.createView() },
            { binding: 2, resource: textureA.createView() },
            { binding: 4, resource: { buffer: stampUniformBuffer } },
            { binding: 5, resource: { buffer: patternDataBuffer } },
        ],
    });

    // --- Generate Icons ---
    function generatePatternIcon(pattern) {
        const iconCanvas = document.createElement("canvas");
        iconCanvas.width = pattern.w;
        iconCanvas.height = pattern.h;
        const ctx = iconCanvas.getContext("2d");

        const imgData = ctx.createImageData(pattern.w, pattern.h);
        for (let i = 0; i < pattern.data.length; i++) {
            const val = pattern.data[i];
            const offset = i * 4;
            if (val === 1) {
                imgData.data[offset] = 0;   // R
                imgData.data[offset + 1] = 255; // G
                imgData.data[offset + 2] = 204; // B
                imgData.data[offset + 3] = 255; // A
            } else {
                imgData.data[offset] = 0;
                imgData.data[offset + 1] = 0;
                imgData.data[offset + 2] = 0;
                imgData.data[offset + 3] = 0;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        return iconCanvas.toDataURL();
    }

    function initStampUI() {
        patterns.forEach((p, index) => {
            const btn = document.createElement("div");
            btn.className = "pattern-btn";
            if (index === 0) btn.classList.add("active");

            const img = document.createElement("img");
            img.src = generatePatternIcon(p);
            btn.appendChild(img);

            btn.addEventListener("click", () => {
                document.querySelectorAll(".pattern-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                currentPatternIndex = index;
            });

            patternGrid.appendChild(btn);
        });
    }
    initStampUI();

    stampToggleBtn.addEventListener("click", () => {
        isStampActive = !isStampActive;
        stampToggleBtn.textContent = isStampActive ? "ON" : "OFF";
        stampControls.classList.toggle("hidden", !isStampActive);

        if (isStampActive) {
            overlayCanvas.style.pointerEvents = "auto";
        } else {
            overlayCanvas.style.pointerEvents = "none";
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        }
    });

    // --- Mouse Handling ---
    function getGridPos(e) {
        const rect = overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const gridX = Math.floor((x / rect.width) * GRID_SIZE);
        const gridY = Math.floor((y / rect.height) * GRID_SIZE);
        return { x: gridX, y: gridY };
    }

    overlayCanvas.addEventListener("mousemove", (e) => {
        if (!isStampActive) return;
        const pos = getGridPos(e);
        mouseX = pos.x;
        mouseY = pos.y;

        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        const pattern = patterns[currentPatternIndex];
        const pixelW = overlayCanvas.width / GRID_SIZE;
        const pixelH = overlayCanvas.height / GRID_SIZE;

        overlayCtx.fillStyle = "rgba(255, 255, 255, 0.5)";

        for (let py = 0; py < pattern.h; py++) {
            for (let px = 0; px < pattern.w; px++) {
                if (pattern.data[py * pattern.w + px] === 1) {
                    overlayCtx.fillRect(
                        (mouseX + px) * pixelW,
                        (mouseY + py) * pixelH,
                        pixelW,
                        pixelH
                    );
                }
            }
        }
    });

    overlayCanvas.addEventListener("click", (e) => {
        if (!isStampActive) return;
        const pos = getGridPos(e);
        const pattern = patterns[currentPatternIndex];

        const patternArray = new Uint32Array(pattern.data);
        device.queue.writeBuffer(patternDataBuffer, 0, patternArray);

        device.queue.writeBuffer(stampUniformBuffer, 0, new Int32Array([pos.x, pos.y, pattern.w, pattern.h]));

        const commandEncoder = device.createCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(stampPipeline);
        pass.setBindGroup(0, useTextureA ? stampBindGroupA : stampBindGroupB);
        pass.dispatchWorkgroups(Math.ceil(GRID_SIZE / WORKGROUP_SIZE), Math.ceil(GRID_SIZE / WORKGROUP_SIZE));
        pass.end();

        device.queue.submit([commandEncoder.finish()]);

        useTextureA = !useTextureA;

        if (!isPlaying) {
            requestAnimationFrame(frame);
        }
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
    const colorAlwaysDeadInput = document.getElementById("colorAlwaysDead");
    const colorAlwaysAliveInput = document.getElementById("colorAlwaysAlive");
    const systemPresetBtn = document.getElementById("systemPresetBtn");

    // --- State ---
    let frameCount = 0;
    let lastTime = performance.now();
    let generation = 0;
    let useTextureA = true;
    let isPlaying = false;
    let fpsInterval = 1000 / 12;
    let then = performance.now();

    // --- Initialization ---
    const blankData = new Float32Array(GRID_SIZE * GRID_SIZE);
    blankData.fill(0.0);

    function uploadData(data) {
        device.queue.writeTexture(
            { texture: textureA },
            data,
            { bytesPerRow: GRID_SIZE * 4 },
            { width: GRID_SIZE, height: GRID_SIZE }
        );
        device.queue.writeTexture(
            { texture: textureB },
            data,
            { bytesPerRow: GRID_SIZE * 4 },
            { width: GRID_SIZE, height: GRID_SIZE }
        );
        generation = 0;
        genElem.textContent = `Gen: ${generation}`;
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
            data[mid * GRID_SIZE + i] = 2.0;
            data[i * GRID_SIZE + mid] = 2.0;
        }
        uploadData(data);
    });

    dotBtn.addEventListener("click", () => {
        const data = new Float32Array(GRID_SIZE * GRID_SIZE);
        data.fill(0.0);
        const mid = Math.floor(GRID_SIZE / 2);
        const r = 2;
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
        const r_dot = R / 5;

        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                const dx = x - mid;
                const dy = y - mid;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > R) {
                    data[y * GRID_SIZE + x] = 2.0;
                    continue;
                }

                const d_top = Math.sqrt(dx * dx + (dy + R / 2) ** 2);
                const d_bot = Math.sqrt(dx * dx + (dy - R / 2) ** 2);

                if (d_top < r_dot) {
                    data[y * GRID_SIZE + x] = 4.0;
                } else if (d_bot < r_dot) {
                    data[y * GRID_SIZE + x] = 3.0;
                }
                else if (d_top < R / 2) {
                    data[y * GRID_SIZE + x] = 0.0;
                } else if (d_bot < R / 2) {
                    data[y * GRID_SIZE + x] = 1.0;
                }
                else if (dx > 0) {
                    data[y * GRID_SIZE + x] = 1.0;
                } else {
                    data[y * GRID_SIZE + x] = 0.0;
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
        updatePalette(
            colorBgInput.value,
            colorFgInput.value,
            colorChaosInput.value,
            colorAlwaysDeadInput.value,
            colorAlwaysAliveInput.value
        );
    }

    colorBgInput.addEventListener("input", handleColorChange);
    colorFgInput.addEventListener("input", handleColorChange);
    colorChaosInput.addEventListener("input", handleColorChange);
    colorAlwaysDeadInput.addEventListener("input", handleColorChange);
    colorAlwaysAliveInput.addEventListener("input", handleColorChange);

    systemPresetBtn.addEventListener("click", () => {
        colorBgInput.value = "#29AE93";
        colorFgInput.value = "#00FFCC";
        colorChaosInput.value = "#FFA500";
        colorAlwaysDeadInput.value = "#003300";
        colorAlwaysAliveInput.value = "#CCFFCC";
        updatePalette("#29AE93", "#00FFCC", "#FFA500", "#003300", "#CCFFCC");
    });

    // --- Resize Handling ---
    function resize() {
        const displayWidth = canvas.clientWidth;
        const displayHeight = canvas.clientHeight;

        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth;
            canvas.height = displayHeight;
            overlayCanvas.width = displayWidth;
            overlayCanvas.height = displayHeight;
        }
    }
    window.addEventListener('resize', resize);
    resize();

    // --- Simulation Loop ---
    function frame() {
        requestAnimationFrame(frame);

        const now = performance.now();
        const elapsed = now - then;

        device.queue.writeBuffer(timeBuffer, 0, new Float32Array([now / 1000.0]));

        if (now - lastTime >= 1000) {
            fpsElem.textContent = `FPS: ${frameCount}`;
            frameCount = 0;
            lastTime = now;
        }

        if (isPlaying && elapsed < fpsInterval) {
            // Skip
        } else {
            if (isPlaying) {
                then = now - (elapsed % fpsInterval);
                generation++;
                genElem.textContent = `Gen: ${generation}`;
                frameCount++;
            }

            const commandEncoder = device.createCommandEncoder();

            if (isPlaying) {
                const computePass = commandEncoder.beginComputePass();
                computePass.setPipeline(computePipeline);
                computePass.setBindGroup(0, useTextureA ? computeBindGroupA : computeBindGroupB);
                computePass.dispatchWorkgroups(Math.ceil(GRID_SIZE / WORKGROUP_SIZE), Math.ceil(GRID_SIZE / WORKGROUP_SIZE));
                computePass.end();
            }

            const textureView = context.getCurrentTexture().createView();
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 },
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
