// WebGPU Integration Module
// This module provides integration between the voxel engine and WebGPU mesh generation

import { isWebGPUSupported, WebGPUMesher } from './webgpu-mesher.js';
import { CHUNK_SIZE } from './constants.js';

// Singleton instance of the WebGPU mesher
let gpuMesher = null;

// Statistics for WebGPU mesh generation
const gpuMeshStats = {
    enabled: false,
    supported: false,
    totalMeshesGenerated: 0,
    meshGenTime: 0,
    avgMeshGenTime: 0
};

// Initialize WebGPU meshing if supported
export async function initWebGPU() {
    // Check if WebGPU is supported
    gpuMeshStats.supported = isWebGPUSupported();
    
    if (!gpuMeshStats.supported) {
        console.warn('WebGPU is not supported in this browser. Using CPU-based meshing instead.');
        return false;
    }
    
    try {
        // Initialize the WebGPU mesher
        gpuMesher = new WebGPUMesher();
        const success = await gpuMesher.init(CHUNK_SIZE);
        
        if (success) {
            gpuMeshStats.enabled = true;
            console.log('WebGPU mesh generation enabled');
            return true;
        } else {
            console.warn('WebGPU initialization failed. Using CPU-based meshing instead.');
            return false;
        }
    } catch (error) {
        console.error('Error initializing WebGPU:', error);
        return false;
    }
}

// Generate a mesh using WebGPU
export async function generateMeshWithGPU(chunk) {
    if (!gpuMeshStats.enabled || !gpuMesher) {
        return null;
    }
    
    try {
        const startTime = performance.now();
        
        // Generate mesh using WebGPU
        const meshData = await gpuMesher.generateMesh(chunk);
        
        const endTime = performance.now();
        const elapsed = endTime - startTime;
        
        // Update statistics
        gpuMeshStats.totalMeshesGenerated++;
        gpuMeshStats.meshGenTime += elapsed;
        gpuMeshStats.avgMeshGenTime = gpuMeshStats.meshGenTime / gpuMeshStats.totalMeshesGenerated;
        
        return meshData;
    } catch (error) {
        console.error('Error generating mesh with WebGPU:', error);
        return null;
    }
}

// Get WebGPU mesh generation statistics
export function getWebGPUStats() {
    return {
        ...gpuMeshStats,
        available: gpuMeshStats.supported && gpuMeshStats.enabled
    };
}

// Check if a chunk is eligible for GPU-based mesh generation
export function isChunkEligibleForGPU(chunk) {
    // Only use GPU for larger chunks or chunks with many voxels
    // This is just a simple heuristic - you might want to use something more sophisticated
    
    if (!gpuMeshStats.enabled) {
        return false;
    }
    
    // Count non-empty voxels in the chunk
    let nonEmptyVoxels = 0;
    
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                if (chunk.getVoxel(x, y, z) !== 0) {
                    nonEmptyVoxels++;
                    
                    // If we've found enough non-empty voxels to justify GPU meshing
                    if (nonEmptyVoxels > CHUNK_SIZE * CHUNK_SIZE) {
                        return true;
                    }
                }
            }
        }
    }
    
    return false;
}

// Helper function to convert WebGPU mesh format to renderer format
export function convertMeshFormat(gpuMesh) {
    if (!gpuMesh) return null;
    
    return {
        positions: Array.from(gpuMesh.positions),
        normals: Array.from(gpuMesh.normals),
        colors: Array.from(gpuMesh.colors),
        indices: Array.from(gpuMesh.indices)
    };
} 