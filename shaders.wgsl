// Vertex Shader
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0)
    );

    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    // Map [-1, 1] to [0, 1] for UVs, flipping Y if necessary
    output.uv = pos[vertexIndex] * 0.5 + 0.5;
    output.uv.y = 1.0 - output.uv.y; 
    return output;
}

// Compute Shader
@group(0) @binding(1) var cellStateIn: texture_2d<f32>;
@group(0) @binding(2) var cellStateOut: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<uniform> time: f32; // Time for PRNG

// Pseudo-random number generator
fn rand(co: vec2<f32>) -> f32 {
    return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

@compute @workgroup_size(16, 16)
fn computeMain(@builtin(global_invocation_id) cell: vec3<u32>) {
    let x = i32(cell.x);
    let y = i32(cell.y);
    let size = textureDimensions(cellStateIn);
    let width = i32(size.x);
    let height = i32(size.y);

    if (x >= width || y >= height) {
        return;
    }

    let currentState = textureLoad(cellStateIn, vec2<i32>(x, y), 0).r;

    // Immutable States
    // State 2: Chaos (Random)
    if (currentState > 1.5 && currentState < 2.5) {
        textureStore(cellStateOut, vec2<i32>(x, y), vec4<f32>(2.0, 0.0, 0.0, 1.0));
        return;
    }
    // State 3: Always Dead
    if (currentState > 2.5 && currentState < 3.5) {
        textureStore(cellStateOut, vec2<i32>(x, y), vec4<f32>(3.0, 0.0, 0.0, 1.0));
        return;
    }
    // State 4: Always Alive
    if (currentState > 3.5) {
        textureStore(cellStateOut, vec2<i32>(x, y), vec4<f32>(4.0, 0.0, 0.0, 1.0));
        return;
    }

    var activeNeighbors = 0;

    for (var i = -1; i <= 1; i++) {
        for (var j = -1; j <= 1; j++) {
            if (i == 0 && j == 0) {
                continue;
            }

            // Wrap edges
            let nx = (x + i + width) % width;
            let ny = (y + j + height) % height;

            let neighborState = textureLoad(cellStateIn, vec2<i32>(nx, ny), 0).r;

            if (neighborState > 0.5 && neighborState < 1.5) {
                // Normal Alive (State 1)
                activeNeighbors++;
            } else if (neighborState > 1.5 && neighborState < 2.5) {
                // Chaos (State 2) - Randomly contributes 0 or 1
                let seed = vec2<f32>(f32(nx) + time * 10.0, f32(ny) + f32(i * 3 + j));
                if (rand(seed) > 0.5) {
                    activeNeighbors++;
                }
            } else if (neighborState > 3.5) {
                // Always Alive (State 4) - Contributes 1
                activeNeighbors++;
            }
            // State 3 (Always Dead) contributes 0, so no check needed
        }
    }

    // Day and Night Rules (B3678/S34678)
    // 0 = Dead, 1 = Alive
    var nextState = 0.0;
    if (currentState > 0.5) {
        // Survival: 3, 4, 6, 7, 8
        if (activeNeighbors == 3 || activeNeighbors == 4 || activeNeighbors == 6 || activeNeighbors == 7 || activeNeighbors == 8) {
            nextState = 1.0;
        }
    } else {
        // Birth: 3, 6, 7, 8
        if (activeNeighbors == 3 || activeNeighbors == 6 || activeNeighbors == 7 || activeNeighbors == 8) {
            nextState = 1.0;
        }
    }

    textureStore(cellStateOut, vec2<i32>(x, y), vec4<f32>(nextState, 0.0, 0.0, 1.0));
}

// --- Stamp Tool Shader ---

struct StampUniforms {
    clickPos: vec2<i32>,
    patternSize: vec2<i32>,
};

@group(0) @binding(4) var<uniform> stampUniforms: StampUniforms;
@group(0) @binding(5) var<storage, read> patternData: array<u32>;

@compute @workgroup_size(16, 16)
fn stampMain(@builtin(global_invocation_id) cell: vec3<u32>) {
    // Optimization: We dispatch ONLY the size of the pattern.
    // So 'cell' (global_invocation_id) corresponds to the pattern coordinate (0..w, 0..h).
    
    let px = i32(cell.x);
    let py = i32(cell.y);
    
    if (px >= stampUniforms.patternSize.x || py >= stampUniforms.patternSize.y) {
        return;
    }

    // Calculate Grid Coordinate with Wrapping
    // gridX = (clickPos.x + px) % 256
    let width = i32(textureDimensions(cellStateIn).x);
    let height = i32(textureDimensions(cellStateIn).y);
    
    let gridX = (stampUniforms.clickPos.x + px) % width;
    let gridY = (stampUniforms.clickPos.y + py) % height;
    
    // Handle negative wrapping (if clickPos was negative? Though usually we pass positive)
    let gx = select(gridX, gridX + width, gridX < 0);
    let gy = select(gridY, gridY + height, gridY < 0);

    let patternIndex = py * stampUniforms.patternSize.x + px;
    let patternVal = patternData[patternIndex];
    
    if (patternVal == 1u) {
        let currentState = textureLoad(cellStateIn, vec2<i32>(gx, gy), 0).r;
        var nextState = currentState;
        
        // FLIP LOGIC
        if (currentState > -0.5 && currentState < 0.5) { // 0
            nextState = 1.0;
        } else if (currentState > 0.5 && currentState < 1.5) { // 1
            nextState = 0.0;
        } else if (currentState > 2.5 && currentState < 3.5) { // 3 (Always Dead)
            nextState = 4.0;
        } else if (currentState > 3.5 && currentState < 4.5) { // 4 (Always Alive)
            nextState = 3.0;
        }
        
        textureStore(cellStateOut, vec2<i32>(gx, gy), vec4<f32>(nextState, 0.0, 0.0, 1.0));
    } else {
        // If pattern is 0, we do NOTHING?
        // Wait, if we only dispatch for the pattern, we are NOT copying the rest of the grid!
        // CRITICAL ISSUE: If we optimize dispatch to only cover the pattern, 
        // who copies the REST of the grid from In to Out?
        // 
        // If we use a separate "Stamp Pass", we need to copy the WHOLE grid.
        // Unless we can write to the SAME texture (Read-Write).
        // But we are using ping-pong textures.
        //
        // Options:
        // 1. Dispatch Full Grid (Old way) - Copies everything, modifies stamp.
        // 2. Copy Texture -> Texture first (CommandEncoder.copyTextureToTexture), THEN dispatch Stamp Kernel over just the area.
        // 
        // Option 2 is the optimization!
        // Copy is very fast. Then we only run compute on the small area.
        //
        // So `stampMain` should ONLY write the changed pixels.
        // It does NOT need to copy unchanged pixels (because we will do a copy first).
        
        // So we don't need an 'else' block.
    }
}

// --- History / Trails Shader ---

struct HistoryUniforms {
    decay: f32,
    isActive: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(7) var<uniform> historyUniforms: HistoryUniforms;
@group(0) @binding(8) var historyIn: texture_2d<f32>;
@group(0) @binding(9) var historyOut: texture_storage_2d<r32float, write>;

@compute @workgroup_size(16, 16)
fn historyMain(@builtin(global_invocation_id) cell: vec3<u32>) {
    let x = i32(cell.x);
    let y = i32(cell.y);
    let size = textureDimensions(cellStateIn);
    let width = i32(size.x);
    let height = i32(size.y);

    if (x >= width || y >= height) {
        return;
    }

    let currentState = textureLoad(cellStateIn, vec2<i32>(x, y), 0).r;
    let oldHistory = textureLoad(historyIn, vec2<i32>(x, y), 0).r;
    
    var newHistory = oldHistory * historyUniforms.decay;
    
    if (currentState > 0.5 && currentState < 1.5) {
        newHistory = 1.0;
    } else if (currentState > 3.5) {
        newHistory = 1.0;
    }
    
    if (historyUniforms.isActive < 0.5) {
        newHistory = 0.0;
    }

    textureStore(historyOut, vec2<i32>(x, y), vec4<f32>(newHistory, 0.0, 0.0, 1.0));
}

// Fragment Shader
struct Palette {
    bg: vec4<f32>,
    fg: vec4<f32>,
    chaos: vec4<f32>,
    alwaysDead: vec4<f32>,
    alwaysAlive: vec4<f32>,
    trail: vec4<f32>, // Added Trail Color
};

struct ViewUniforms {
    offset: vec2<f32>,
    scale: f32,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> palette: Palette;
@group(0) @binding(3) var cellTexture: texture_2d<f32>;
@group(0) @binding(6) var<uniform> view: ViewUniforms;
@group(0) @binding(8) var historyTexture: texture_2d<f32>;

@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(cellTexture));
    
    let world_uv = fract((uv / view.scale) - view.offset);
    
    let coords = vec2<i32>(world_uv * size);
    let state = textureLoad(cellTexture, coords, 0).r;
    let history = textureLoad(historyTexture, coords, 0).r;
    
    var color = palette.bg;
    
    // Base Color Logic
    if (state > 3.5) {
        color = palette.alwaysAlive;
    } else if (state > 2.5) {
        color = palette.alwaysDead;
    } else if (state > 1.5) {
        color = palette.chaos;
    } else if (state > 0.5) {
        color = palette.fg;
    }
    
    // Trail Overlay
    // We mix the trail color on top based on history value.
    // history is 0..1.
    // We want a subtle effect.
    // If history is high, we tint towards trail color.
    // But we don't want to obscure the cell state completely.
    // Let's use a "screen" or "additive" like blend, or just mix.
    
    if (history > 0.01) {
        // Only blend if there is history
        let trailAlpha = history * 0.6; // Max 60% opacity
        color = mix(color, palette.trail, trailAlpha);
    }
    
    return color;
}
