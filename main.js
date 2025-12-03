let gridSize = 256;
const WORKGROUP_SIZE = 16;

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

    const requiredFeatures = [];
    if (adapter.features.has('timestamp-query')) {
        requiredFeatures.push('timestamp-query');
    }

    const device = await adapter.requestDevice({
        requiredFeatures: requiredFeatures
    });

    const canvas = document.getElementById("gpuCanvas");
    const context = canvas.getContext("webgpu");
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
        device: device,
        format: presentationFormat,
        alphaMode: "premultiplied",
    });

    // --- Profiling Setup ---
    const canProfile = device.features.has('timestamp-query');
    let querySet;
    let queryResolveBuffer;
    let queryResultBuffer;

    if (canProfile) {
        querySet = device.createQuerySet({
            type: "timestamp",
            count: 4,
        });

        queryResolveBuffer = device.createBuffer({
            size: 4 * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });

        queryResultBuffer = device.createBuffer({
            size: 4 * 8,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
    }

    const shaderModule = device.createShaderModule({
        label: "Cellular Automata Shaders",
        code: await (await fetch("./shaders.wgsl")).text(),
    });

    // --- Pipelines ---
    const computePipeline = device.createComputePipeline({
        label: "Compute Pipeline",
        layout: "auto",
        compute: {
            module: shaderModule,
            entryPoint: "computeMain",
        },
    });

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

    const historyPipeline = device.createComputePipeline({
        label: "History Pipeline",
        layout: "auto",
        compute: {
            module: shaderModule,
            entryPoint: "historyMain",
        },
    });

    const stampPipeline = device.createComputePipeline({
        label: "Stamp Pipeline",
        layout: "auto",
        compute: {
            module: shaderModule,
            entryPoint: "stampMain",
        },
    });

    // --- Buffers (Size Independent) ---
    const timeBuffer = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const paletteBufferSize = 96;
    const paletteBuffer = device.createBuffer({
        size: paletteBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const viewUniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const historyUniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const stampUniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const patternDataBuffer = device.createBuffer({
        size: 1024,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // --- Dynamic Resources ---
    let textureA, textureB;
    let historyTextureA, historyTextureB;
    let computeBindGroupA, computeBindGroupB;
    let historyBindGroupA, historyBindGroupB;
    let renderBindGroupA, renderBindGroupB;
    let stampBindGroupA, stampBindGroupB;

    function initSimulationResources(size) {
        gridSize = size;

        if (textureA) textureA.destroy();
        if (textureB) textureB.destroy();
        if (historyTextureA) historyTextureA.destroy();
        if (historyTextureB) historyTextureB.destroy();

        const textureDesc = {
            size: [gridSize, gridSize],
            format: "r32float",
            usage: GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.STORAGE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.COPY_SRC,
        };

        textureA = device.createTexture(textureDesc);
        textureB = device.createTexture(textureDesc);
        historyTextureA = device.createTexture(textureDesc);
        historyTextureB = device.createTexture(textureDesc);

        // --- Bind Groups ---
        computeBindGroupA = device.createBindGroup({
            layout: computePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 1, resource: textureA.createView() },
                { binding: 2, resource: textureB.createView() },
                { binding: 3, resource: { buffer: timeBuffer } },
            ],
        });

        computeBindGroupB = device.createBindGroup({
            layout: computePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 1, resource: textureB.createView() },
                { binding: 2, resource: textureA.createView() },
                { binding: 3, resource: { buffer: timeBuffer } },
            ],
        });

        historyBindGroupA = device.createBindGroup({
            layout: historyPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 1, resource: textureA.createView() },
                { binding: 7, resource: { buffer: historyUniformBuffer } },
                { binding: 8, resource: historyTextureA.createView() },
                { binding: 9, resource: historyTextureB.createView() },
            ],
        });

        historyBindGroupB = device.createBindGroup({
            layout: historyPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 1, resource: textureB.createView() },
                { binding: 7, resource: { buffer: historyUniformBuffer } },
                { binding: 8, resource: historyTextureB.createView() },
                { binding: 9, resource: historyTextureA.createView() },
            ],
        });

        renderBindGroupA = device.createBindGroup({
            layout: renderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: paletteBuffer } },
                { binding: 3, resource: textureA.createView() },
                { binding: 6, resource: { buffer: viewUniformBuffer } },
                { binding: 8, resource: historyTextureA.createView() },
            ],
        });

        renderBindGroupB = device.createBindGroup({
            layout: renderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: paletteBuffer } },
                { binding: 3, resource: textureB.createView() },
                { binding: 6, resource: { buffer: viewUniformBuffer } },
                { binding: 8, resource: historyTextureB.createView() },
            ],
        });

        stampBindGroupA = device.createBindGroup({
            layout: stampPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 1, resource: textureA.createView() },
                { binding: 2, resource: textureB.createView() },
                { binding: 4, resource: { buffer: stampUniformBuffer } },
                { binding: 5, resource: { buffer: patternDataBuffer } },
            ],
        });

        stampBindGroupB = device.createBindGroup({
            layout: stampPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 1, resource: textureB.createView() },
                { binding: 2, resource: textureA.createView() },
                { binding: 4, resource: { buffer: stampUniformBuffer } },
                { binding: 5, resource: { buffer: patternDataBuffer } },
            ],
        });

        generation = 0;
        genElem.textContent = `Gen: ${generation}`;
        useTextureA = true;

        const blankData = new Float32Array(gridSize * gridSize);
        blankData.fill(0.0);
        uploadData(blankData);
    }

    let zoom = 1.0;
    let panX = 0.0;
    let panY = 0.0;
    let trailsActive = false;
    let decayValue = 0.9;
    let statsEnabled = false;

    function updateViewUniforms() {
        device.queue.writeBuffer(viewUniformBuffer, 0, new Float32Array([panX, panY, zoom, 0.0]));
    }
    updateViewUniforms();

    function updateHistoryUniforms() {
        device.queue.writeBuffer(historyUniformBuffer, 0, new Float32Array([decayValue, trailsActive ? 1.0 : 0.0, 0.0, 0.0]));
    }
    updateHistoryUniforms();

    function hexToRgb(hex) {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return [r, g, b, 1.0];
    }

    function updatePalette(bgHex, fgHex, chaosHex, alwaysDeadHex, alwaysAliveHex, trailHex) {
        const bg = hexToRgb(bgHex);
        const fg = hexToRgb(fgHex);
        const chaos = hexToRgb(chaosHex);
        const alwaysDead = hexToRgb(alwaysDeadHex);
        const alwaysAlive = hexToRgb(alwaysAliveHex);
        const trail = hexToRgb(trailHex);

        const data = new Float32Array([...bg, ...fg, ...chaos, ...alwaysDead, ...alwaysAlive, ...trail]);
        device.queue.writeBuffer(paletteBuffer, 0, data);
    }

    updatePalette("#29AE93", "#00FFCC", "#FFA500", "#003300", "#CCFFCC", "#FF00FF");

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
        if (!patternGrid) return;
        patternGrid.innerHTML = '';
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
            overlayCanvas.style.pointerEvents = "auto";
        }
    });

    // --- Mouse Handling (Zoom/Pan/Stamp) ---
    let isDragging = false;
    let lastMouseX = 0;
    let lastMouseY = 0;

    function getGridPos(clientX, clientY) {
        const rect = overlayCanvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;

        const u = x / rect.width;
        const v = y / rect.height;

        let worldU = (u / zoom) - panX;
        let worldV = (v / zoom) - panY;

        worldU = worldU - Math.floor(worldU);
        worldV = worldV - Math.floor(worldV);

        const gridX = Math.floor(worldU * gridSize);
        const gridY = Math.floor(worldV * gridSize);

        return { x: gridX, y: gridY };
    }

    overlayCanvas.addEventListener("wheel", (e) => {
        e.preventDefault();

        const rect = overlayCanvas.getBoundingClientRect();
        const mouseU = (e.clientX - rect.left) / rect.width;
        const mouseV = (e.clientY - rect.top) / rect.height;

        const zoomFactor = 1.1;
        const newZoom = e.deltaY < 0 ? zoom * zoomFactor : zoom / zoomFactor;

        if (newZoom < 0.5 || newZoom > 50.0) return;

        panX = (mouseU / newZoom) - (mouseU / zoom) + panX;
        panY = (mouseV / newZoom) - (mouseV / zoom) + panY;

        zoom = newZoom;
        updateViewUniforms();

        if (isStampActive) {
            drawGhost(e.clientX, e.clientY);
        }

        if (!isPlaying) requestAnimationFrame(frame);
    }, { passive: false });

    overlayCanvas.addEventListener("mousedown", (e) => {
        if (e.button === 1 || (e.button === 0 && e.getModifierState("Space"))) {
            isDragging = true;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            e.preventDefault();
        } else if (e.button === 0 && isStampActive) {
            handleStampClick(e);
        }
    });

    window.addEventListener("mousemove", (e) => {
        if (isDragging) {
            const dx = e.clientX - lastMouseX;
            const dy = e.clientY - lastMouseY;
            const rect = overlayCanvas.getBoundingClientRect();

            panX += dx / rect.width / zoom;
            panY += dy / rect.height / zoom;

            updateViewUniforms();

            lastMouseX = e.clientX;
            lastMouseY = e.clientY;

            if (!isPlaying) requestAnimationFrame(frame);
        }

        if (isStampActive && !isDragging) {
            drawGhost(e.clientX, e.clientY);
        }
    });

    window.addEventListener("mouseup", () => {
        isDragging = false;
    });

    function drawGhost(clientX, clientY) {
        const pos = getGridPos(clientX, clientY);
        mouseX = pos.x;
        mouseY = pos.y;

        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        const pattern = patterns[currentPatternIndex];

        const rect = overlayCanvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        const originX = panX * zoom * width;
        const originY = panY * zoom * height;

        const cellW = (width / gridSize) * zoom;
        const cellH = (height / gridSize) * zoom;

        overlayCtx.fillStyle = "rgba(255, 255, 255, 0.5)";

        for (let py = 0; py < pattern.h; py++) {
            for (let px = 0; px < pattern.w; px++) {
                if (pattern.data[py * pattern.w + px] === 1) {
                    const snapX = Math.floor((clientX - rect.left - originX) / cellW) * cellW + originX;
                    const snapY = Math.floor((clientY - rect.top - originY) / cellH) * cellH + originY;

                    overlayCtx.fillRect(
                        snapX + px * cellW,
                        snapY + py * cellH,
                        cellW,
                        cellH
                    );
                }
            }
        }
    }

    function handleStampClick(e) {
        const pos = getGridPos(e.clientX, e.clientY);
        const pattern = patterns[currentPatternIndex];

        const patternArray = new Uint32Array(pattern.data);
        device.queue.writeBuffer(patternDataBuffer, 0, patternArray);

        device.queue.writeBuffer(stampUniformBuffer, 0, new Int32Array([pos.x, pos.y, pattern.w, pattern.h]));

        const commandEncoder = device.createCommandEncoder();

        const src = useTextureA ? textureA : textureB;
        const dst = useTextureA ? textureB : textureA;

        commandEncoder.copyTextureToTexture(
            { texture: src },
            { texture: dst },
            [gridSize, gridSize]
        );

        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(stampPipeline);
        pass.setBindGroup(0, useTextureA ? stampBindGroupA : stampBindGroupB);
        pass.dispatchWorkgroups(Math.ceil(pattern.w / WORKGROUP_SIZE), Math.ceil(pattern.h / WORKGROUP_SIZE));
        pass.end();

        device.queue.submit([commandEncoder.finish()]);

        useTextureA = !useTextureA;

        if (!isPlaying) {
            requestAnimationFrame(frame);
        }
    }

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

    const trailsToggle = document.getElementById("trailsToggle");
    const decayRange = document.getElementById("decayRange");
    const statsToggle = document.getElementById("statsToggle");
    const gridSizeSelect = document.getElementById("gridSizeSelect");

    const colorBgInput = document.getElementById("colorBg");
    const colorFgInput = document.getElementById("colorFg");
    const colorChaosInput = document.getElementById("colorChaos");
    const colorAlwaysDeadInput = document.getElementById("colorAlwaysDead");
    const colorAlwaysAliveInput = document.getElementById("colorAlwaysAlive");
    const colorTrailInput = document.getElementById("colorTrail");
    const systemPresetBtn = document.getElementById("systemPresetBtn");

    // --- State ---
    let frameCount = 0;
    let lastTime = performance.now();
    let generation = 0;
    let useTextureA = true;
    let isPlaying = false;
    let fpsInterval = 1000 / 12;
    let then = performance.now();

    function uploadData(data) {
        device.queue.writeTexture(
            { texture: textureA },
            data,
            { bytesPerRow: gridSize * 4 },
            { width: gridSize, height: gridSize }
        );
        device.queue.writeTexture(
            { texture: textureB },
            data,
            { bytesPerRow: gridSize * 4 },
            { width: gridSize, height: gridSize }
        );
        generation = 0;
        genElem.textContent = `Gen: ${generation}`;
        useTextureA = true;
    }

    // --- Event Listeners ---
    playPauseBtn.addEventListener("click", () => {
        isPlaying = !isPlaying;
        playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
    });

    trailsToggle.addEventListener("change", (e) => {
        trailsActive = e.target.checked;
        updateHistoryUniforms();
    });

    decayRange.addEventListener("input", (e) => {
        decayValue = parseFloat(e.target.value);
        updateHistoryUniforms();
    });

    statsToggle.addEventListener("change", (e) => {
        statsEnabled = e.target.checked;
        if (!statsEnabled) {
            fpsElem.textContent = `FPS: ${frameCount}`;
        }
    });

    gridSizeSelect.addEventListener("change", (e) => {
        const newSize = parseInt(e.target.value);
        initSimulationResources(newSize);
        zoom = 1.0;
        panX = 0.0;
        panY = 0.0;
        updateViewUniforms();
    });

    randomSoupBtn.addEventListener("click", () => {
        const data = new Float32Array(gridSize * gridSize);
        for (let i = 0; i < gridSize * gridSize; i++) {
            data[i] = Math.random() > 0.5 ? 1.0 : 0.0;
        }
        uploadData(data);
    });

    crossBtn.addEventListener("click", () => {
        const data = new Float32Array(gridSize * gridSize);
        data.fill(0.0);
        const mid = Math.floor(gridSize / 2);
        for (let i = 0; i < gridSize; i++) {
            data[mid * gridSize + i] = 2.0;
            data[i * gridSize + mid] = 2.0;
        }
        uploadData(data);
    });

    dotBtn.addEventListener("click", () => {
        const data = new Float32Array(gridSize * gridSize);
        data.fill(0.0);
        const mid = Math.floor(gridSize / 2);
        const r = 2;
        for (let y = mid - r; y <= mid + r; y++) {
            for (let x = mid - r; x <= mid + r; x++) {
                data[y * gridSize + x] = 2.0;
            }
        }
        uploadData(data);
    });

    yinYangBtn.addEventListener("click", () => {
        const data = new Float32Array(gridSize * gridSize);
        const mid = gridSize / 2;
        const R = gridSize / 3;
        const r_dot = R / 5;

        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const dx = x - mid;
                const dy = y - mid;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > R) {
                    data[y * gridSize + x] = 2.0;
                    continue;
                }

                const d_top = Math.sqrt(dx * dx + (dy + R / 2) ** 2);
                const d_bot = Math.sqrt(dx * dx + (dy - R / 2) ** 2);

                if (d_top < r_dot) {
                    data[y * gridSize + x] = 4.0;
                } else if (d_bot < r_dot) {
                    data[y * gridSize + x] = 3.0;
                }
                else if (d_top < R / 2) {
                    data[y * gridSize + x] = 0.0;
                } else if (d_bot < R / 2) {
                    data[y * gridSize + x] = 1.0;
                }
                else if (dx > 0) {
                    data[y * gridSize + x] = 1.0;
                } else {
                    data[y * gridSize + x] = 0.0;
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
            colorAlwaysAliveInput.value,
            colorTrailInput.value
        );
    }

    colorBgInput.addEventListener("input", handleColorChange);
    colorFgInput.addEventListener("input", handleColorChange);
    colorChaosInput.addEventListener("input", handleColorChange);
    colorAlwaysDeadInput.addEventListener("input", handleColorChange);
    colorAlwaysAliveInput.addEventListener("input", handleColorChange);
    colorTrailInput.addEventListener("input", handleColorChange);

    systemPresetBtn.addEventListener("click", () => {
        colorBgInput.value = "#29AE93";
        colorFgInput.value = "#00FFCC";
        colorChaosInput.value = "#FFA500";
        colorAlwaysDeadInput.value = "#003300";
        colorAlwaysAliveInput.value = "#CCFFCC";
        colorTrailInput.value = "#FF00FF";
        updatePalette("#29AE93", "#00FFCC", "#FFA500", "#003300", "#CCFFCC", "#FF00FF");
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
            if (!statsEnabled) {
                fpsElem.textContent = `FPS: ${frameCount}`;
            }
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
                // 1. Compute Pass
                const computePassDescriptor = {
                    layout: "auto",
                    compute: {
                        module: shaderModule,
                        entryPoint: "computeMain",
                    },
                };

                if (statsEnabled && canProfile) {
                    computePassDescriptor.timestampWrites = {
                        querySet: querySet,
                        beginningOfPassWriteIndex: 0,
                        endOfPassWriteIndex: 1,
                    };
                }

                const computePass = commandEncoder.beginComputePass(computePassDescriptor);
                computePass.setPipeline(computePipeline);
                computePass.setBindGroup(0, useTextureA ? computeBindGroupA : computeBindGroupB);
                computePass.dispatchWorkgroups(Math.ceil(gridSize / WORKGROUP_SIZE), Math.ceil(gridSize / WORKGROUP_SIZE));
                computePass.end();

                // 2. History Pass
                const historyPass = commandEncoder.beginComputePass();
                historyPass.setPipeline(historyPipeline);
                historyPass.setBindGroup(0, useTextureA ? historyBindGroupB : historyBindGroupA);
                historyPass.dispatchWorkgroups(Math.ceil(gridSize / WORKGROUP_SIZE), Math.ceil(gridSize / WORKGROUP_SIZE));
                historyPass.end();
            }

            const textureView = context.getCurrentTexture().createView();
            const renderPassDescriptor = {
                colorAttachments: [{
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                }],
            };

            if (statsEnabled && canProfile) {
                renderPassDescriptor.timestampWrites = {
                    querySet: querySet,
                    beginningOfPassWriteIndex: 2,
                    endOfPassWriteIndex: 3,
                };
            }

            const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor);
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

            if (statsEnabled && canProfile) {
                commandEncoder.resolveQuerySet(querySet, 0, 4, queryResolveBuffer, 0);
                commandEncoder.copyBufferToBuffer(queryResolveBuffer, 0, queryResultBuffer, 0, 32);
            }

            device.queue.submit([commandEncoder.finish()]);

            if (statsEnabled && canProfile) {
                if (queryResultBuffer.mapState === 'unmapped') {
                    queryResultBuffer.mapAsync(GPUMapMode.READ).then(() => {
                        const times = new BigInt64Array(queryResultBuffer.getMappedRange());

                        let computeTime = 0;
                        if (isPlaying) {
                            computeTime = Number(times[1] - times[0]) / 1000000;
                        }
                        const renderTime = Number(times[3] - times[2]) / 1000000;

                        fpsElem.textContent = `FPS: ${frameCount} | Comp: ${computeTime.toFixed(2)}ms | Rend: ${renderTime.toFixed(2)}ms`;

                        queryResultBuffer.unmap();
                    });
                }
            }

            if (isPlaying) {
                useTextureA = !useTextureA;
            }
        }
    }

    initSimulationResources(256);

    requestAnimationFrame(frame);
}

init();
