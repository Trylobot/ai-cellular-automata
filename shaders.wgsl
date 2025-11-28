// Shader for Day and Night Cellular Automata

@group(0) @binding(1) var cellStateIn: texture_2d<f32>;
@group(0) @binding(2) var cellStateOut: texture_storage_2d<r32float, write>;

// Compute Shader
@compute @workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) cell: vec3<u32>) {
    let size = textureDimensions(cellStateIn);
    let x = i32(cell.x);
    let y = i32(cell.y);

    if (x >= i32(size.x) || y >= i32(size.y)) {
        return;
    }

    // Count neighbors with wrapping
    var neighbors = 0;
    for (var i = -1; i <= 1; i++) {
        for (var j = -1; j <= 1; j++) {
            if (i == 0 && j == 0) {
                continue;
            }
            
            // Wrap coordinates
            let nx = (x + i + i32(size.x)) % i32(size.x);
            let ny = (y + j + i32(size.y)) % i32(size.y);
            
            let state = textureLoad(cellStateIn, vec2<i32>(nx, ny), 0).r;
            if (state > 0.5) {
                neighbors++;
            }
        }
    }

    let currentState = textureLoad(cellStateIn, vec2<i32>(x, y), 0).r > 0.5;
    var nextState = false;

    // Day and Night Rules: B3678/S34678
    // Birth: 3, 6, 7, 8
    // Survival: 3, 4, 6, 7, 8
    
    if (currentState) {
        // Survival
        if (neighbors == 3 || neighbors == 4 || neighbors == 6 || neighbors == 7 || neighbors == 8) {
            nextState = true;
        }
    } else {
        // Birth
        if (neighbors == 3 || neighbors == 6 || neighbors == 7 || neighbors == 8) {
            nextState = true;
        }
    }

    let val = select(0.0, 1.0, nextState);
    textureStore(cellStateOut, vec2<i32>(x, y), vec4<f32>(val, 0.0, 0.0, 1.0));
}

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
    // Map [-1, 1] to [0, 1] for UVs, flipping Y if necessary (WebGPU is bottom-left origin for textures usually, but let's check standard quad UVs)
    output.uv = pos[vertexIndex] * 0.5 + 0.5;
    output.uv.y = 1.0 - output.uv.y; // Flip Y to match texture coords
    return output;
}

// Fragment Shader
@group(0) @binding(3) var cellTexture: texture_2d<f32>;

@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let size = textureDimensions(cellTexture);
    let coords = vec2<i32>(uv * vec2<f32>(size));
    let state = textureLoad(cellTexture, coords, 0).r;
    
    // Aesthetic coloring
    // Background: Dark Blue/Black
    // Active: Bright Cyan/White
    
    let bg = vec3<f32>(0.02, 0.02, 0.05);
    let fg = vec3<f32>(0.0, 1.0, 0.8); // Cyan
    
    let color = mix(bg, fg, state);
    
    return vec4<f32>(color, 1.0);
}
