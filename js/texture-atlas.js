// Texture atlas system for efficient texture management
import { VoxelType } from './voxel-types.js';
import { debugLog } from './math-utils.js';

export class TextureAtlas {
    constructor(gl) {
        this.gl = gl;
        this.texture = null;
        this.tileSize = 16;
        this.atlasSize = 256;
        this.tilesPerRow = this.atlasSize / this.tileSize;
        this.textureMap = new Map();
        this.uvCache = new Map();
        this.isLoaded = false;
        this.loadingPromise = null;

        // Create a placeholder texture for use while loading
        this.createPlaceholderTexture();

        // Start loading textures
        this.loadingPromise = this.loadTextures();
    }
    createPlaceholderTexture() {
        const gl = this.gl;
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        // Use a single magenta pixel
        const pixel = new Uint8Array([255, 0, 255, 255]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        // Set texture parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Load textures and create atlas
    async loadTextures() {
        return new Promise((resolve) => {
            // Create a canvas to build the atlas
            const canvas = document.createElement('canvas');
            canvas.width = this.atlasSize;
            canvas.height = this.atlasSize;
            const ctx = canvas.getContext('2d');

            // Fill with placeholder color
            ctx.fillStyle = '#FF00FF'; // Magenta for debugging
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Define and draw texture positions as before...
            const texturePositions = [
                // Format: [voxelType, face, tileX, tileY]
                [VoxelType.GRASS, 'top', 0, 0],
                [VoxelType.GRASS, 'side', 1, 0],
                [VoxelType.GRASS, 'bottom', 2, 0],
                [VoxelType.DIRT, 'all', 2, 0],
                [VoxelType.STONE, 'all', 3, 0],
                [VoxelType.BEDROCK, 'all', 4, 0],
                [VoxelType.WATER, 'all', 5, 0]
            ];

            // Draw textures as before...
            for (const [voxelType, face, tileX, tileY] of texturePositions) {
                // Store and draw textures as in original code...
                // [existing code for drawing textures]

                // Store texture position in map
                const key = this.getTextureKey(voxelType, face);
                this.textureMap.set(key, { tileX, tileY });

                // Draw colored rectangle for this texture
                const x = tileX * this.tileSize;
                const y = tileY * this.tileSize;

                // Get color for this texture from voxel type
                let color;
                switch (voxelType) {
                    case VoxelType.GRASS:
                        if (face === 'top') {
                            color = '#7CFC00'; // Grass top
                        } else if (face === 'side') {
                            color = '#8B4513'; // Grass side
                        } else {
                            color = '#8B4513'; // Dirt
                        }
                        break;
                    case VoxelType.DIRT:
                        color = '#8B4513'; // Dirt
                        break;
                    case VoxelType.STONE:
                        color = '#808080'; // Stone
                        break;
                    case VoxelType.BEDROCK:
                        color = '#383838'; // Bedrock
                        break;
                    case VoxelType.WATER:
                        color = '#0000FF'; // Water
                        break;
                    default:
                        color = '#FF00FF'; // Magenta for missing textures
                }

                // Draw rectangle
                ctx.fillStyle = color;
                ctx.fillRect(x, y, this.tileSize, this.tileSize);

                // Add some texture detail
                if (voxelType === VoxelType.GRASS && face === 'top') {
                    // Add grass pattern
                    ctx.fillStyle = '#90EE90';
                    for (let i = 0; i < 20; i++) {
                        const gx = x + Math.random() * this.tileSize;
                        const gy = y + Math.random() * this.tileSize;
                        ctx.fillRect(gx, gy, 1, 2);
                    }
                } else if (voxelType === VoxelType.STONE) {
                    // Add stone pattern
                    ctx.fillStyle = '#A9A9A9';
                    for (let i = 0; i < 10; i++) {
                        const sx = x + Math.random() * this.tileSize;
                        const sy = y + Math.random() * this.tileSize;
                        const size = 1 + Math.random() * 3;
                        ctx.fillRect(sx, sy, size, size);
                    }
                }
            }

            // Create a texture from the canvas
            this.createTextureFromCanvas(canvas);

            this.isLoaded = true;
            debugLog('TextureAtlas: Created');
            resolve();
        });
    }

    // Create WebGL texture from canvas
    createTextureFromCanvas(canvas) {
        const gl = this.gl;

        // Create and bind texture
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        // Upload the canvas to the texture
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);

        // Set texture parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Get texture key for lookups
    getTextureKey(voxelType, face) {
        return `${voxelType}_${face}`;
    }

    // Get UV coordinates for a voxel type and face
    getUVsForFace(voxelType, face) {
        const cacheKey = this.getTextureKey(voxelType, face);

        // Return from cache if available
        if (this.uvCache.has(cacheKey)) {
            return this.uvCache.get(cacheKey);
        }

        // Look up in texture map
        let texturePos = this.textureMap.get(cacheKey);

        // Fall back to 'all' face if specific face not found
        if (!texturePos) {
            texturePos = this.textureMap.get(this.getTextureKey(voxelType, 'all'));
        }

        // Fall back to default if still not found
        if (!texturePos) {
            texturePos = { tileX: 0, tileY: 0 };
        }

        // Calculate UV coordinates
        const tileSize = this.tileSize;
        const atlasSize = this.atlasSize;

        const u0 = texturePos.tileX * tileSize / atlasSize;
        const v0 = texturePos.tileY * tileSize / atlasSize;
        const u1 = (texturePos.tileX + 1) * tileSize / atlasSize;
        const v1 = (texturePos.tileY + 1) * tileSize / atlasSize;

        const uvs = [
            u0, v0,  // Bottom-left
            u1, v0,  // Bottom-right
            u1, v1,  // Top-right
            u0, v1   // Top-left
        ];

        // Cache the result
        this.uvCache.set(cacheKey, uvs);

        return uvs;
    }

    // Bind the texture atlas for rendering
    bind(textureUnit = 0) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        return textureUnit;
    }

    // Add a method to check if textures are loaded
    isTextureLoaded() {
        return this.isLoaded;
    }

    // Clean up resources
    dispose() {
        if (this.texture) {
            this.gl.deleteTexture(this.texture);
            this.texture = null;
        }

        this.textureMap.clear();
        this.uvCache.clear();

        debugLog('TextureAtlas: Disposed');
    }
}