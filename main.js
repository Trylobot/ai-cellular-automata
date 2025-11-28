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

    // --- UI Elements ---
    const fpsElem = document.getElementById("fps");
    const genElem = document.getElementById("generation");
    const playPauseBtn = document.getElementById("playPauseBtn");
    const randomSoupBtn = document.getElementById("randomSoupBtn");
    const fpsCapInput = document.getElementById("fpsCap");
    const toggleMenuBtn = document.getElementById("toggleMenuBtn");
    const overlay = document.getElementById("overlay");

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

    // --- Sampler for rendering ---
    const sampler = device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
    });

    // --- Bind Groups ---
    // We need two bind groups for compute (A->B and B->A)
    const computeBindGroupA = device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 1, resource: textureA.createView() },
            { binding: 2, resource: textureB.createView() },
        ],
    });

    const computeBindGroupB = device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 1, resource: textureB.createView() },
            { binding: 2, resource: textureA.createView() },
        ],
    });

    // We need two bind groups for rendering (Read A or Read B)
    const renderBindGroupA = device.createBindGroup({
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 3, resource: textureA.createView() },
        ],
    });

    const renderBindGroupB = device.createBindGroup({
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 3, resource: textureB.createView() },
        ],
    });

    // --- Event Listeners ---
    playPauseBtn.addEventListener("click", () => {
        isPlaying = !isPlaying;
        playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
    });

    randomSoupBtn.addEventListener("click", () => {
        const soupData = new Float32Array(GRID_SIZE * GRID_SIZE);
        for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
            soupData[i] = Math.random() > 0.5 ? 1.0 : 0.0;
        }
        uploadData(soupData);
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
                    clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1 }, // Match bg color
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
