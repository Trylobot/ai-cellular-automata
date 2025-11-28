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

    // Initial Smiley Face
    // r32float requires Float32Array, 1 channel per pixel
    const data = new Float32Array(GRID_SIZE * GRID_SIZE);

    // Clear to 0
    data.fill(0.0);

    // Draw Smiley
    const cx = GRID_SIZE / 2;
    const cy = GRID_SIZE / 2;
    const radius = 50;

    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const idx = y * GRID_SIZE + x;
            const dx = x - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Face circle outline
            if (Math.abs(dist - radius) < 2) {
                data[idx] = 1.0;
            }

            // Eyes
            if (Math.abs(dist - 20) < 5 && y < cy - 10) {
                // Left eye
                if (Math.abs(x - (cx - 20)) < 5) data[idx] = 1.0;
                // Right eye
                if (Math.abs(x - (cx + 20)) < 5) data[idx] = 1.0;
            }

            // Mouth (Arc)
            if (Math.abs(dist - 30) < 2 && y > cy + 10) {
                data[idx] = 1.0;
            }
        }
    }

    device.queue.writeTexture(
        { texture: textureA },
        data,
        { bytesPerRow: GRID_SIZE * 4 }, // 1 float = 4 bytes
        { width: GRID_SIZE, height: GRID_SIZE }
    );

    // Uniform Buffer for Grid Size
    const uniformBufferSize = 8; // 2 * f32
    const uniformBuffer = device.createBuffer({
        size: uniformBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([GRID_SIZE, GRID_SIZE]));

    // Sampler for rendering
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
    // Actually, we always render the *result* of the compute pass.
    // If compute went A->B, we render B.
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
    let frameCount = 0;
    let lastTime = performance.now();
    let generation = 0;
    let useTextureA = true; // Input texture is A, Output is B
    let isPlaying = false;

    const fpsElem = document.getElementById("fps");
    const genElem = document.getElementById("generation");
    const playPauseBtn = document.getElementById("playPauseBtn");

    playPauseBtn.addEventListener("click", () => {
        console.log("Play/Pause clicked");
        isPlaying = !isPlaying;
        playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
    });

    function frame() {
        const now = performance.now();
        frameCount++;
        if (now - lastTime >= 1000) {
            fpsElem.textContent = `FPS: ${frameCount}`;
            frameCount = 0;
            lastTime = now;
        }

        const commandEncoder = device.createCommandEncoder();

        if (isPlaying) {
            generation++;
            genElem.textContent = `Gen: ${generation}`;

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
                clearValue: { r: 0.2, g: 0.0, b: 0.2, a: 1 }, // Debug Purple
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        renderPass.setPipeline(renderPipeline);

        // Render the CURRENT state.
        // If isPlaying, we just computed new state into the "output" texture (if useTextureA, output is B).
        // If !isPlaying, we want to render the "current" valid texture.
        // Logic:
        // Start: useTextureA = true. Data is in A.
        // Frame 1 (Paused): Render A.
        // Frame 1 (Playing): Compute A->B. Render B. Swap -> useTextureA = false.

        let textureToRender;
        if (isPlaying) {
            // We just computed into the "other" texture
            textureToRender = useTextureA ? renderBindGroupB : renderBindGroupA;
        } else {
            // We are paused, render the "current" input texture
            textureToRender = useTextureA ? renderBindGroupA : renderBindGroupB;
        }

        renderPass.setBindGroup(0, textureToRender);
        renderPass.draw(6);
        renderPass.end();

        device.queue.submit([commandEncoder.finish()]);

        if (isPlaying) {
            // Swap buffers for next frame
            useTextureA = !useTextureA;
        }

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

init();
