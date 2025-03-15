// Import constants
self.CHUNK_SIZE = 16; // Default value, will be overridden by main thread

// Handle messages from main thread
self.onmessage = function(e) {
    const { type, data } = e.data;
    
    switch (type) {
        case 'init':
            // Set constants sent from main thread
            self.CHUNK_SIZE = data.CHUNK_SIZE;
            self.postMessage({ type: 'initialized' });
            break;
            
        case 'generateMesh':
            // Generate mesh from voxel data
            const mesh = generateMesh(data.chunk, data.chunkX, data.chunkY, data.chunkZ);
            
            // Send the mesh back to the main thread
            self.postMessage({
                type: 'meshGenerated',
                mesh: mesh,
                chunkKey: data.chunkKey
            });
            break;
            
        default:
            console.error('Unknown message type:', type);
    }
};

// Simplified mesh generation algorithm that runs in the worker
function generateMesh(chunk, chunkX, chunkY, chunkZ) {
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];
    
    let indexOffset = 0;
    
    // Greedy meshing algorithm (simplified version)
    // Process each axis direction
    for (let dim = 0; dim < 3; dim++) {
        // Determine which dimensions to iterate over based on current dim
        const u = (dim + 1) % 3;
        const v = (dim + 2) % 3;
        
        // Iterate over each slice in the dimension
        for (let w = 0; w < CHUNK_SIZE; w++) {
            // Create masks for this slice
            const mask = create2DMask(CHUNK_SIZE);
            
            // Fill the mask with voxel data
            for (let v_val = 0; v_val < CHUNK_SIZE; v_val++) {
                for (let u_val = 0; u_val < CHUNK_SIZE; u_val++) {
                    // Set coordinates based on current dimensions
                    const coords = [0, 0, 0];
                    coords[dim] = w;
                    coords[u] = u_val;
                    coords[v] = v_val;
                    
                    // Get voxel type
                    const voxelType = getVoxelAt(chunk, coords[0], coords[1], coords[2]);
                    
                    // Skip air blocks
                    if (voxelType === 0) continue;
                    
                    // Check if the face should be visible
                    const adjCoords = [...coords];
                    adjCoords[dim] += 1; // Check adjacent voxel in this dimension
                    
                    const adjVoxel = w < CHUNK_SIZE - 1 ? 
                        getVoxelAt(chunk, adjCoords[0], adjCoords[1], adjCoords[2]) : 0;
                    
                    // Only create face if this voxel is visible from this direction
                    if (adjVoxel === 0) {
                        mask[v_val][u_val] = {
                            voxelType,
                            merged: false
                        };
                    }
                }
            }
            
            // Generate mesh from the mask using greedy meshing
            indexOffset = greedyMesh(
                mask, dim, w, u, v, 
                positions, normals, colors, indices, indexOffset
            );
            
            // Now check the opposite direction
            const maskNeg = create2DMask(CHUNK_SIZE);
            
            for (let v_val = 0; v_val < CHUNK_SIZE; v_val++) {
                for (let u_val = 0; u_val < CHUNK_SIZE; u_val++) {
                    const coords = [0, 0, 0];
                    coords[dim] = w;
                    coords[u] = u_val;
                    coords[v] = v_val;
                    
                    // Check if we're at the edge
                    if (w > 0) {
                        const voxelType = getVoxelAt(chunk, coords[0], coords[1], coords[2]);
                        
                        if (voxelType === 0) {
                            // Look at the voxel behind this one
                            const adjCoords = [...coords];
                            adjCoords[dim] -= 1;
                            
                            const adjVoxel = getVoxelAt(chunk, adjCoords[0], adjCoords[1], adjCoords[2]);
                            
                            // Only create a face if the adjacent voxel is solid
                            if (adjVoxel !== 0) {
                                maskNeg[v_val][u_val] = {
                                    voxelType: adjVoxel,
                                    merged: false
                                };
                            }
                        }
                    }
                }
            }
            
            // Generate mesh for negative direction
            const normalDir = getNormal(dim, false);
            indexOffset = greedyMesh(
                maskNeg, dim, w, u, v, 
                positions, normals, colors, indices, indexOffset,
                normalDir
            );
        }
    }
    
    return { positions, normals, colors, indices };
}

// Get voxel type from chunk data
function getVoxelAt(chunk, x, y, z) {
    // Make sure coordinates are in bounds
    if (x < 0 || y < 0 || z < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE || z >= CHUNK_SIZE) {
        return 0; // Air outside chunk
    }
    
    // Access chunk data
    // For flat array: return chunk.data[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE];
    // For octree: Use the provided structure
    return chunk.getVoxel(x, y, z);
}

// Create a 2D mask for a slice
function create2DMask(size) {
    const mask = new Array(size);
    for (let i = 0; i < size; i++) {
        mask[i] = new Array(size).fill(null);
    }
    return mask;
}

// Get normal vector for a dimension and direction
function getNormal(dim, positive) {
    const normal = [0, 0, 0];
    normal[dim] = positive ? 1 : -1;
    return normal;
}

// Greedy meshing algorithm
function greedyMesh(mask, dim, w, u, v, positions, normals, colors, indices, indexOffset, normalDir) {
    const normal = normalDir || getNormal(dim, true);
    
    const size = mask.length;
    
    // Try to merge adjacent faces
    for (let v_val = 0; v_val < size; v_val++) {
        for (let u_val = 0; u_val < size; u_val++) {
            const cell = mask[v_val][u_val];
            
            // Skip empty or already merged cells
            if (!cell || cell.merged) continue;
            
            // Try to find largest possible rectangle
            let width = 1;
            let height = 1;
            
            // Expand width as far as possible
            while (u_val + width < size) {
                const nextCell = mask[v_val][u_val + width];
                if (!nextCell || nextCell.merged || nextCell.voxelType !== cell.voxelType) break;
                width++;
            }
            
            // Try to expand height
            let canExpandHeight = true;
            
            while (canExpandHeight && v_val + height < size) {
                for (let dx = 0; dx < width; dx++) {
                    const nextCell = mask[v_val + height][u_val + dx];
                    if (!nextCell || nextCell.merged || nextCell.voxelType !== cell.voxelType) {
                        canExpandHeight = false;
                        break;
                    }
                }
                
                if (canExpandHeight) height++;
            }
            
            // Mark cells as merged
            for (let dy = 0; dy < height; dy++) {
                for (let dx = 0; dx < width; dx++) {
                    mask[v_val + dy][u_val + dx].merged = true;
                }
            }
            
            // Add quad to mesh
            const coords = [0, 0, 0];
            coords[dim] = w;
            coords[u] = u_val;
            coords[v] = v_val;
            
            // Generate vertices for quad
            addQuad(
                positions, normals, colors, indices,
                coords, dim, u, v, width, height,
                normal, cell.voxelType, indexOffset
            );
            
            indexOffset += 4; // 4 vertices per quad
        }
    }
    
    return indexOffset;
}

// Add a quad to the mesh
function addQuad(positions, normals, colors, indices, origin, dim, u, v, width, height, normal, voxelType, indexOffset) {
    // Calculate vertex positions
    const pos = [
        [...origin],
        [...origin],
        [...origin],
        [...origin]
    ];
    
    // Adjust positions based on width and height
    pos[1][u] += width;
    pos[2][u] += width;
    pos[2][v] += height;
    pos[3][v] += height;
    
    // Add vertices to arrays
    for (let i = 0; i < 4; i++) {
        positions.push(pos[i][0], pos[i][1], pos[i][2]);
        normals.push(normal[0], normal[1], normal[2]);
        
        // Get color from voxel type
        const color = getVoxelColor(voxelType);
        colors.push(color.r, color.g, color.b, color.a);
    }
    
    // Add indices for triangles (two per quad)
    indices.push(
        indexOffset, indexOffset + 1, indexOffset + 2,
        indexOffset, indexOffset + 2, indexOffset + 3
    );
}

// Get color for voxel type
function getVoxelColor(voxelType) {
    // Basic color palette
    switch(voxelType) {
        case 1: return {r: 0.5, g: 0.5, b: 0.5, a: 1.0}; // Stone
        case 2: return {r: 0.0, g: 0.5, b: 0.0, a: 1.0}; // Grass
        case 3: return {r: 0.6, g: 0.3, b: 0.0, a: 1.0}; // Dirt
        case 4: return {r: 0.5, g: 0.5, b: 0.5, a: 0.5}; // Glass
        default: return {r: 1.0, g: 0.0, b: 1.0, a: 1.0}; // Missing texture
    }
} 