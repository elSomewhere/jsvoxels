// Buffer manager for WebGL buffer pooling and reuse
import { debugLog } from './math-utils.js';
import { BUFFER_POOL_SIZE } from './constants.js';


export class BufferManager {
    constructor(gl) {
        this.gl = gl;

        // Pools for different buffer types
        this.vertexBufferPool = [];
        this.indexBufferPool = [];
        this.normalBufferPool = [];
        this.colorBufferPool = [];
        this.uvBufferPool = [];

        // Currently allocated buffers
        this.allocatedBuffers = new Map();

        // Statistics
        this.stats = {
            created: 0,
            reused: 0,
            released: 0,
            active: 0
        };
    }

    // Get a buffer from pool or create a new one
    // Modify the getBuffer method to properly manage pool sizes
    getBuffer(type, data, usage = this.gl.STATIC_DRAW) {
        let pool;
        switch (type) {
            case 'vertex':
                pool = this.vertexBufferPool;
                break;
            case 'index':
                pool = this.indexBufferPool;
                break;
            case 'normal':
                pool = this.normalBufferPool;
                break;
            case 'color':
                pool = this.colorBufferPool;
                break;
            case 'uv':
                pool = this.uvBufferPool;
                break;
            default:
                throw new Error(`Unknown buffer type: ${type}`);
        }

        // Find a buffer in the pool that's large enough
        let buffer = null;
        let dataSize = data.byteLength;
        let foundIndex = -1;

        for (let i = 0; i < pool.length; i++) {
            const pooledBuffer = pool[i];
            if (pooledBuffer.size >= dataSize) {
                // Found a suitable buffer
                buffer = pooledBuffer.buffer;
                // Remember the index for removal
                foundIndex = i;
                break;
            }
        }

        // If we found a buffer, remove it from the pool
        if (foundIndex !== -1) {
            pool.splice(foundIndex, 1);
            this.stats.reused++;
        } else {
            // Create a new buffer if none found
            buffer = this.gl.createBuffer();
            this.stats.created++;
        }

        // Bind and upload data
        if (type === 'index') {
            this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buffer);
            this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, data, usage);
        } else {
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, data, usage);
        }

        // Track this buffer
        const id = Date.now() + Math.random().toString(36).substr(2, 9);
        this.allocatedBuffers.set(id, {
            id,
            buffer,
            type,
            size: dataSize
        });

        this.stats.active++;

        return {
            id,
            buffer
        };
    }

    // Return a buffer to the pool
    releaseBuffer(id) {
        const bufferInfo = this.allocatedBuffers.get(id);
        if (!bufferInfo) {
            return false;
        }

        // Remove from allocated map
        this.allocatedBuffers.delete(id);

        let pool;
        // Select the appropriate pool
        switch (bufferInfo.type) {
            case 'vertex':
                pool = this.vertexBufferPool;
                break;
            case 'index':
                pool = this.indexBufferPool;
                break;
            case 'normal':
                pool = this.normalBufferPool;
                break;
            case 'color':
                pool = this.colorBufferPool;
                break;
            case 'uv':
                pool = this.uvBufferPool;
                break;
        }

        // Check if pool is at max capacity
        if (pool.length >= BUFFER_POOL_SIZE) {
            // Delete the buffer instead of adding to the pool
            this.gl.deleteBuffer(bufferInfo.buffer);
        } else {
            // Add to pool
            pool.push(bufferInfo);
        }

        this.stats.released++;
        this.stats.active--;

        return true;
    }

    // Delete a buffer permanently
    deleteBuffer(id) {
        const bufferInfo = this.allocatedBuffers.get(id);
        if (!bufferInfo) {
            return false;
        }

        // Delete WebGL buffer
        this.gl.deleteBuffer(bufferInfo.buffer);

        // Remove from allocated map
        this.allocatedBuffers.delete(id);

        this.stats.active--;

        return true;
    }

    // Clear all pools
    clearPools() {
        // Delete all buffers in pools
        function clearPool(pool) {
            for (const bufferInfo of pool) {
                this.gl.deleteBuffer(bufferInfo.buffer);
            }
            pool.length = 0;
        }

        clearPool.call(this, this.vertexBufferPool);
        clearPool.call(this, this.indexBufferPool);
        clearPool.call(this, this.normalBufferPool);
        clearPool.call(this, this.colorBufferPool);
        clearPool.call(this, this.uvBufferPool);

        debugLog('BufferManager: All pools cleared');
    }

    // Get buffer stats
    getStats() {
        const poolSizes = {
            vertex: this.vertexBufferPool.length,
            index: this.indexBufferPool.length,
            normal: this.normalBufferPool.length,
            color: this.colorBufferPool.length,
            uv: this.uvBufferPool.length
        };

        return {
            ...this.stats,
            poolSizes
        };
    }

    // Clean up resources
    dispose() {
        // Delete all allocated buffers
        for (const bufferInfo of this.allocatedBuffers.values()) {
            this.gl.deleteBuffer(bufferInfo.buffer);
        }

        // Clear pools
        this.clearPools();

        // Reset stats
        this.stats = {
            created: 0,
            reused: 0,
            released: 0,
            active: 0
        };

        debugLog('BufferManager: Disposed');
    }
}