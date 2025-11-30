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

@compute @workgroup_size(8, 8)
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
@group(0) @binding(5) var<storage, read> patternData: array<u32>; // Packed bits? Or just 0/1 ints? Let's use u32 0/1 for simplicity.

@compute @workgroup_size(8, 8)
fn stampKernel(@builtin(global_invocation_id) cell: vec3<u32>) {
    let x = i32(cell.x);
    let y = i32(cell.y);
    
    // We only need to run this for the size of the pattern
    if (x >= stampUniforms.patternSize.x || y >= stampUniforms.patternSize.y) {
        return;
    }

    let gridX = (stampUniforms.clickPos.x + x) % 256; // Hardcoded grid size for now, or pass it
    let gridY = (stampUniforms.clickPos.y + y) % 256;
    
    // Handle negative wrapping if needed (though % usually handles positive)
    let gx = select(gridX, gridX + 256, gridX < 0);
    let gy = select(gridY, gridY + 256, gridY < 0);

    let patternIndex = y * stampUniforms.patternSize.x + x;
    let patternVal = patternData[patternIndex];

    if (patternVal == 1u) {
        // Flip logic
        // Load current state from textureA (or whichever is current)
        // Wait, we need to read/write to the SAME texture for a stamp, or ping-pong.
        // For simplicity, let's assume we read from 'cellStateIn' and write to 'cellStateOut' 
        // effectively copying the whole grid but modifying the stamped area.
        // BUT, that requires running over the whole grid.
        
        // Better approach: The stamp kernel ONLY runs on the stamped area.
        // It reads the current value, flips it, and writes it back.
        // Storage textures support read-write in some tiers, but safe bet is:
        // We are modifying the "current" state. 
        // If we are paused, we can just modify the current texture.
        // If we are playing, it might be tricky to stamp mid-frame.
        // Let's assume we stamp on the "Input" texture.
        
        // Actually, WGSL storage textures are usually write-only or read-only unless "storage-texture-tier-2" feature.
        // So we can't easily read-modify-write the same texture in one pass without that feature.
        
        // Alternative: CPU stamping? No, user asked for GPU.
        // Alternative: A full-screen compute pass that copies everything, and flips if inside stamp area.
        // Yes, let's do a full grid pass for the stamp. It's fast enough.
    }
}

// Re-thinking Stamp Kernel:
// We will run a compute pass over the ENTIRE grid (like simulation).
// It will copy 'In' to 'Out'.
// IF the pixel is within the stamp area AND the pattern bit is 1, it will FLIP the value.
// This is robust and easy.

@compute @workgroup_size(8, 8)
fn stampMain(@builtin(global_invocation_id) cell: vec3<u32>) {
    let x = i32(cell.x);
    let y = i32(cell.y);
    let size = textureDimensions(cellStateIn);
    let width = i32(size.x);
    let height = i32(size.y);

    if (x >= width || y >= height) {
        return;
    }

    let currentState = textureLoad(cellStateIn, vec2<i32>(x, y), 0).r;
    var nextState = currentState;

    // Check if within stamp area relative to clickPos
    // We need to handle wrapping logic relative to the click.
    // Let's assume clickPos is top-left of the stamp.
    
    // Calculate relative coordinates
    let dx = (x - stampUniforms.clickPos.x + width) % width;
    let dy = (y - stampUniforms.clickPos.y + height) % height;

    if (dx < stampUniforms.patternSize.x && dy < stampUniforms.patternSize.y) {
        let patternIndex = dy * stampUniforms.patternSize.x + dx;
        let patternVal = patternData[patternIndex];
        
        if (patternVal == 1u) {
            // FLIP LOGIC
            // 0 <-> 1
            // 3 <-> 4
            // 2 (Chaos) -> No Change
            
            if (currentState > -0.5 && currentState < 0.5) { // 0
                nextState = 1.0;
            } else if (currentState > 0.5 && currentState < 1.5) { // 1
                nextState = 0.0;
            } else if (currentState > 2.5 && currentState < 3.5) { // 3 (Always Dead)
                nextState = 4.0;
            } else if (currentState > 3.5 && currentState < 4.5) { // 4 (Always Alive)
                nextState = 3.0;
            }
        }
    }

    textureStore(cellStateOut, vec2<i32>(x, y), vec4<f32>(nextState, 0.0, 0.0, 1.0));
}

// Fragment Shader
struct Palette {
    bg: vec4<f32>,
    fg: vec4<f32>,
    chaos: vec4<f32>,
    alwaysDead: vec4<f32>,
    alwaysAlive: vec4<f32>,
};

struct ViewUniforms {
    offset: vec2<f32>,
    scale: f32,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> palette: Palette;
@group(0) @binding(3) var cellTexture: texture_2d<f32>;
@group(0) @binding(6) var<uniform> view: ViewUniforms;

@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(cellTexture));
    
    // Transform UV for Zoom/Pan
    // world_uv = (uv / scale) - offset
    // We use fract() to handle infinite wrapping
    let world_uv = fract((uv / view.scale) - view.offset);
    
    let coords = vec2<i32>(world_uv * size);
    let state = textureLoad(cellTexture, coords, 0).r;
    
    var color = palette.bg;
    if (state > 3.5) {
        color = palette.alwaysAlive;
    } else if (state > 2.5) {
        color = palette.alwaysDead;
    } else if (state > 1.5) {
        color = palette.chaos;
    } else if (state > 0.5) {
        color = palette.fg;
    }
    
    return color;
}
