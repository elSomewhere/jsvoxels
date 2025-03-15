import { DEBUG } from './constants.js';
import { mat4, debugLog } from './math-utils.js';
import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';
import { VoxelType } from './voxel-types.js';

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl');

        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        this.programInfo = null;
        this.initWebGL();
        this.currentFrustum = null;
        
        // Flag to indicate if instanced rendering is supported
        this.supportsInstancedRendering = false;

        // Initialize buffer pools for reusing WebGL buffers
        this.bufferPools = {
            vertices: [],    // Pool of vertex position buffers
            normals: [],     // Pool of normal buffers  
            colors: [],      // Pool of color buffers
            indices: []      // Pool of index buffers
        };
        
        // Keep track of buffer sizes for efficient reuse
        this.bufferSizes = new WeakMap();
        
        // Statistics for monitoring buffer pool usage
        this.bufferStats = {
            created: 0,
            reused: 0,
            returned: 0,
            updated: 0,
            resized: 0
        };

        // Check if instanced rendering is supported
        const ext = this.gl.getExtension('ANGLE_instanced_arrays');
        if (ext) {
            // Alias instanced drawing functions
            this.gl.drawElementsInstanced = ext.drawElementsInstancedANGLE.bind(ext);
            this.gl.vertexAttribDivisor = ext.vertexAttribDivisorANGLE.bind(ext);
            
            // Initialize instanced rendering
            this.initInstancedRendering();
            
            // Set the instanced rendering support flag
            this.supportsInstancedRendering = true;
        } else {
            console.warn('Instanced rendering not supported - falling back to standard rendering');
        }
    }


    // Initialize WebGL
    initWebGL() {
        console.log("Initializing WebGL...");
        
        // Create shaders
        const vsSource = `
            attribute vec4 aVertexPosition;
            attribute vec3 aVertexNormal;
            attribute vec4 aVertexColor;

            uniform mat4 uModelViewMatrix;
            uniform mat4 uProjectionMatrix;
            uniform mat4 uNormalMatrix;

            varying highp vec3 vNormal;
            varying highp vec4 vColor;

            void main(void) {
                gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
                vNormal = (uNormalMatrix * vec4(aVertexNormal, 0.0)).xyz;
                vColor = aVertexColor;
            }
        `;

        const fsSource = `
            precision highp float;
            
            varying highp vec3 vNormal;
            varying highp vec4 vColor;
            
            uniform vec3 uLightDirection;
            
            void main(void) {
                // Calculate lighting
                vec3 normal = normalize(vNormal);
                vec3 lightDir = normalize(uLightDirection);
                float diffuse = max(dot(normal, lightDir), 0.0);
                
                // Add ambient light
                float ambient = 0.3;
                float lighting = diffuse + ambient;
                
                // Apply lighting to color (preserve alpha)
                gl_FragColor = vec4(vColor.rgb * lighting, vColor.a);
            }
        `;

        // Initialize shader program
        const shaderProgram = this.initShaderProgram(vsSource, fsSource);
        console.log("Shader program created:", shaderProgram);
        
        if (!shaderProgram) {
            console.error("Failed to create shader program!");
            return;
        }

        // Store shader program info
        this.programInfo = {
            program: shaderProgram,
            attribLocations: {
                vertexPosition: this.gl.getAttribLocation(shaderProgram, 'aVertexPosition'),
                vertexNormal: this.gl.getAttribLocation(shaderProgram, 'aVertexNormal'),
                vertexColor: this.gl.getAttribLocation(shaderProgram, 'aVertexColor')
            },
            uniformLocations: {
                projectionMatrix: this.gl.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
                modelViewMatrix: this.gl.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
                normalMatrix: this.gl.getUniformLocation(shaderProgram, 'uNormalMatrix'),
                lightDirection: this.gl.getUniformLocation(shaderProgram, 'uLightDirection')
            }
        };
        
        console.log("Program info:", {
            attribLocations: {
                vertexPosition: this.programInfo.attribLocations.vertexPosition,
                vertexNormal: this.programInfo.attribLocations.vertexNormal,
                vertexColor: this.programInfo.attribLocations.vertexColor
            },
            uniformLocations: {
                projectionMatrix: !!this.programInfo.uniformLocations.projectionMatrix,
                modelViewMatrix: !!this.programInfo.uniformLocations.modelViewMatrix,
                normalMatrix: !!this.programInfo.uniformLocations.normalMatrix,
                lightDirection: !!this.programInfo.uniformLocations.lightDirection
            }
        });
    }

    // Initialize a shader program
    initShaderProgram(vsSource, fsSource) {
        console.log("Creating shader program...");
        
        const vertexShader = this.loadShader(this.gl.VERTEX_SHADER, vsSource);
        const fragmentShader = this.loadShader(this.gl.FRAGMENT_SHADER, fsSource);

        // Create the shader program
        const shaderProgram = this.gl.createProgram();
        this.gl.attachShader(shaderProgram, vertexShader);
        this.gl.attachShader(shaderProgram, fragmentShader);
        this.gl.linkProgram(shaderProgram);

        // Check if it linked successfully
        if (!this.gl.getProgramParameter(shaderProgram, this.gl.LINK_STATUS)) {
            console.error('Unable to initialize the shader program: ' + this.gl.getProgramInfoLog(shaderProgram));
            return null;
        }

        console.log("Shader program linked successfully");
        return shaderProgram;
    }

    // Load a shader
    loadShader(type, source) {
        console.log(`Compiling ${type === this.gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader...`);
        
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);

        // Check if it compiled successfully
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('An error occurred compiling the shaders: ' + this.gl.getShaderInfoLog(shader));
            this.gl.deleteShader(shader);
            return null;
        }

        console.log(`${type === this.gl.VERTEX_SHADER ? 'Vertex' : 'Fragment'} shader compiled successfully`);
        return shader;
    }

    // Get a buffer from the pool or create a new one if none available
    getBuffer(type, data, target = this.gl.ARRAY_BUFFER) {
        const pool = this.bufferPools[type];
        const dataLength = data.length;
        
        // Find a buffer in the pool that's at least as large as needed
        // Prefer a buffer that's closest to the size we need to avoid wasting space
        let bestFitIndex = -1;
        let bestFitSize = Infinity;
        
        for (let i = 0; i < pool.length; i++) {
            const buffer = pool[i];
            const bufferSize = this.bufferSizes.get(buffer);
            
            if (bufferSize >= dataLength && bufferSize < bestFitSize) {
                bestFitIndex = i;
                bestFitSize = bufferSize;
            }
        }
        
        let buffer;
        if (bestFitIndex !== -1) {
            // Reuse an existing buffer
            buffer = pool.splice(bestFitIndex, 1)[0];
            this.bufferStats.reused++;
        } else {
            // Create a new buffer if none available
            buffer = this.gl.createBuffer();
            this.bufferStats.created++;
            
            // Log buffer creation occasionally
            if (this.bufferStats.created % 100 === 0) {
                console.log(`Buffer pool stats: created=${this.bufferStats.created}, reused=${this.bufferStats.reused}, returned=${this.bufferStats.returned}`);
                console.log(`Pool sizes: vertices=${this.bufferPools.vertices.length}, normals=${this.bufferPools.normals.length}, colors=${this.bufferPools.colors.length}, indices=${this.bufferPools.indices.length}`);
                
                // Try to trigger garbage collection if available
                if (typeof window.gc === 'function') {
                    window.gc();
                }
            }
        }
        
        // Bind and upload data to the buffer
        this.gl.bindBuffer(target, buffer);
        
        if (target === this.gl.ARRAY_BUFFER) {
            this.gl.bufferData(target, new Float32Array(data), this.gl.STATIC_DRAW);
        } else {
            this.gl.bufferData(target, new Uint16Array(data), this.gl.STATIC_DRAW);
        }
        
        // Store the buffer size for future reference
        this.bufferSizes.set(buffer, dataLength);
        
        return buffer;
    }
    
    // Return a buffer to the pool instead of deleting it
    returnBuffer(buffer, type) {
        if (!buffer) return;
        
        // Add the buffer to the pool
        if (!this.bufferPools[type].includes(buffer)) {
            this.bufferPools[type].push(buffer);
            this.bufferStats.returned++;
        }
        
        // Check if we need to clean up (more aggressive cleanup)
        if (this.bufferStats.returned % 50 === 0 && this.bufferStats.returned > 0) {
            const maxPoolSize = 30; // Reduce the max pool size
            this.cleanupBufferPools(maxPoolSize);
        }
    }

    // Create a mesh in WebGL with buffer pooling
    createMesh(meshData, worldOffset) {
        console.log("Renderer.createMesh called with:", {
            positions: meshData.positions.length,
            normals: meshData.normals.length,
            colors: meshData.colors.length,
            indices: meshData.indices.length,
            worldOffset
        });

        const { positions, normals, colors, indices } = meshData;

        // Get buffers from the pool or create new ones
        const positionBuffer = this.getBuffer('vertices', positions);
        const normalBuffer = this.getBuffer('normals', normals);
        const colorBuffer = this.getBuffer('colors', colors);
        const indexBuffer = this.getBuffer('indices', indices, this.gl.ELEMENT_ARRAY_BUFFER);

        // Return mesh object
        const mesh = {
            position: positionBuffer,
            normal: normalBuffer,
            color: colorBuffer,
            indices: indexBuffer,
            vertexCount: indices.length,
            worldOffset
        };
        
        console.log("Created mesh:", mesh);
        return mesh;
    }

    // Return mesh buffers to pool instead of deleting
    deleteMesh(mesh) {
        if (!mesh) return;
        
        this.returnBuffer(mesh.position, 'vertices');
        this.returnBuffer(mesh.normal, 'normals');
        this.returnBuffer(mesh.color, 'colors');
        this.returnBuffer(mesh.indices, 'indices');
    }
    
    // Get buffer pool statistics
    getBufferPoolStats() {
        return {
            ...this.bufferStats,
            poolSizes: {
                vertices: this.bufferPools.vertices.length,
                normals: this.bufferPools.normals.length,
                colors: this.bufferPools.colors.length,
                indices: this.bufferPools.indices.length
            }
        };
    }
    
    // Clean up buffer pools (call on shutdown or when resizing)
    cleanupBufferPools(maxPoolSize = 30) {
        let totalDeleted = 0;
        
        // Delete excess buffers if pools get too large
        Object.entries(this.bufferPools).forEach(([type, pool]) => {
            const excessBuffers = pool.length - maxPoolSize;
            if (excessBuffers > 0) {
                // Remove the excess buffers from the pool and delete them
                const toDelete = pool.splice(pool.length - excessBuffers, excessBuffers);
                toDelete.forEach(buffer => {
                    this.gl.deleteBuffer(buffer);
                    // Also remove from the size map to prevent memory leak
                    this.bufferSizes.delete(buffer);
                    totalDeleted++;
                });
            }
        });
        
        if (totalDeleted > 0) {
            console.log(`Cleaned up ${totalDeleted} excess buffers from pool`);
        }
        
        // Log current pool sizes
        console.log(`Current pool sizes after cleanup: vertices=${this.bufferPools.vertices.length}, normals=${this.bufferPools.normals.length}, colors=${this.bufferPools.colors.length}, indices=${this.bufferPools.indices.length}`);
        
        return totalDeleted;
    }

    // Resize canvas to match display size
    resizeCanvasToDisplaySize() {
        const displayWidth = this.canvas.clientWidth;
        const displayHeight = this.canvas.clientHeight;

        if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
            this.canvas.width = displayWidth;
            this.canvas.height = displayHeight;
            this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            return true;
        }
        return false;
    }

    // Clear the screen
    clear() {
        this.gl.clearColor(0.6, 0.8, 1.0, 1.0); // Sky blue
        this.gl.clearDepth(1.0);
        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.depthFunc(this.gl.LEQUAL);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        // Draw a test triangle to verify WebGL is working
        this.drawTestTriangle();
    }

    // Draw a simple test triangle to verify WebGL is working
    drawTestTriangle() {
        console.log("Drawing test triangle...");
        
        // Use the shader program
        this.gl.useProgram(this.programInfo.program);
        
        // Create a simple triangle
        const positions = [
            -0.5, -0.5, 0.0,  // Bottom left
             0.5, -0.5, 0.0,  // Bottom right
             0.0,  0.5, 0.0   // Top
        ];
        
        const normals = [
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ];
        
        const colors = [
            1.0, 0.0, 0.0, 1.0,  // Red
            0.0, 1.0, 0.0, 1.0,  // Green
            0.0, 0.0, 1.0, 1.0   // Blue
        ];
        
        const indices = [0, 1, 2];
        
        // Create buffers
        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(positions), this.gl.STATIC_DRAW);
        
        const normalBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(normals), this.gl.STATIC_DRAW);
        
        const colorBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(colors), this.gl.STATIC_DRAW);
        
        const indexBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), this.gl.STATIC_DRAW);
        
        // Set up attributes
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.vertexAttribPointer(
            this.programInfo.attribLocations.vertexPosition,
            3, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexPosition);
        
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
        this.gl.vertexAttribPointer(
            this.programInfo.attribLocations.vertexNormal,
            3, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexNormal);
        
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
        this.gl.vertexAttribPointer(
            this.programInfo.attribLocations.vertexColor,
            4, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexColor);
        
        // Set up uniforms
        const modelViewMatrix = mat4.create();
        const projectionMatrix = mat4.create();
        const normalMatrix = mat4.create();
        
        // Simple orthographic projection
        mat4.perspective(projectionMatrix, 45 * Math.PI / 180, this.gl.canvas.width / this.gl.canvas.height, 0.1, 100.0);
        
        // Move the triangle back a bit
        mat4.translate(modelViewMatrix, modelViewMatrix, [0, 0, -5]);
        
        // Set normal matrix
        mat4.invert(normalMatrix, modelViewMatrix);
        mat4.transpose(normalMatrix, normalMatrix);
        
        // Set uniforms
        this.gl.uniformMatrix4fv(
            this.programInfo.uniformLocations.projectionMatrix,
            false,
            projectionMatrix);
        this.gl.uniformMatrix4fv(
            this.programInfo.uniformLocations.modelViewMatrix,
            false,
            modelViewMatrix);
        this.gl.uniformMatrix4fv(
            this.programInfo.uniformLocations.normalMatrix,
            false,
            normalMatrix);
        this.gl.uniform3fv(
            this.programInfo.uniformLocations.lightDirection,
            [0.5, 1.0, 0.3]);
        
        // Draw the triangle
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        this.gl.drawElements(this.gl.TRIANGLES, 3, this.gl.UNSIGNED_SHORT, 0);
        
        console.log("Test triangle drawn");
    }

    // Render all chunks
    // Render chunks with frustum culling
    renderChunks(meshes, projectionMatrix, viewMatrix) {
        console.log(`Renderer.renderChunks called with ${meshes.length} meshes`);
        
        // Set up alpha blending for transparent blocks
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        // Use the shader program
        this.gl.useProgram(this.programInfo.program);

        // Set light direction
        this.gl.uniform3fv(this.programInfo.uniformLocations.lightDirection, [0.5, 1.0, 0.3]);

        // Create projection-view matrix for frustum culling
        const projViewMatrix = mat4.create();
        mat4.multiply(projViewMatrix, projectionMatrix, viewMatrix);

        // Reset current frustum
        this.currentFrustum = mat4.frustumFromMatrix(projViewMatrix);

        // Draw only visible meshes
        let drawnChunks = 0;
        let skippedChunks = 0;

        // Debugging flag - set to true to completely disable frustum culling
        const debugDisableCulling = true; // TEMPORARILY DISABLED FOR DEBUGGING

        for (const mesh of meshes) {
            // Skip empty meshes
            if (!mesh || mesh.vertexCount === 0) {
                continue;
            }

            // Frustum culling - skip chunks outside view
            // When debugging is enabled, show all meshes regardless of frustum
            if (!debugDisableCulling && !this.isMeshInFrustum(mesh, projViewMatrix)) {
                skippedChunks++;
                continue;
            }

            // Create model matrix with world offset
            const modelMatrix = mat4.create();
            mat4.translate(modelMatrix, modelMatrix, mesh.worldOffset);

            // Combine with view matrix
            const modelViewMatrix = mat4.create();
            mat4.multiply(modelViewMatrix, viewMatrix, modelMatrix);

            // Normal matrix
            const normalMatrix = mat4.create();
            mat4.invert(normalMatrix, modelViewMatrix);
            mat4.transpose(normalMatrix, normalMatrix);

            // Bind position buffer
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.position);
            this.gl.vertexAttribPointer(
                this.programInfo.attribLocations.vertexPosition,
                3, this.gl.FLOAT, false, 0, 0);
            this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexPosition);

            // Bind normal buffer
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.normal);
            this.gl.vertexAttribPointer(
                this.programInfo.attribLocations.vertexNormal,
                3, this.gl.FLOAT, false, 0, 0);
            this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexNormal);

            // Bind color buffer
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.color);
            this.gl.vertexAttribPointer(
                this.programInfo.attribLocations.vertexColor,
                4, this.gl.FLOAT, false, 0, 0);
            this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexColor);

            // Set uniforms
            this.gl.uniformMatrix4fv(
                this.programInfo.uniformLocations.projectionMatrix,
                false,
                projectionMatrix);
            this.gl.uniformMatrix4fv(
                this.programInfo.uniformLocations.modelViewMatrix,
                false,
                modelViewMatrix);
            this.gl.uniformMatrix4fv(
                this.programInfo.uniformLocations.normalMatrix,
                false,
                normalMatrix);

            // Bind indices and draw
            this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
            this.gl.drawElements(this.gl.TRIANGLES, mesh.vertexCount, this.gl.UNSIGNED_SHORT, 0);

            drawnChunks++;
        }

        // Only log this about every 10 frames to avoid spamming console
        if (Math.random() < 0.1) {
            console.log(`Rendered ${drawnChunks} chunks, skipped ${skippedChunks} chunks (${Math.round(drawnChunks / (drawnChunks + skippedChunks) * 100)}% visible)`);
        }

        // Disable blending when done
        this.gl.disable(this.gl.BLEND);
        
        return drawnChunks;
    }

    // Check if a mesh is within the view frustum
    isMeshInFrustum(mesh, projViewMatrix) {
        // For development, we can disable frustum culling entirely
        // return true;
        
        if (!this.currentFrustum) return true;
        
        // Create a bounding box for the chunk with a larger buffer
        // This helps prevent chunks from popping in and out at the edges of the view
        const buffer = 5; // Increased buffer size to prevent popping (was 2)
        const min = [
            mesh.worldOffset[0] - buffer,
            mesh.worldOffset[1] - buffer,
            mesh.worldOffset[2] - buffer
        ];
        const max = [
            min[0] + CHUNK_SIZE + buffer * 2,
            min[1] + CHUNK_SIZE + buffer * 2,
            min[2] + CHUNK_SIZE + buffer * 2
        ];
        
        // Check if the bounding box is in the frustum
        // We use a custom frustum check that is more lenient
        return this.isBoxInFrustumLenient(this.currentFrustum, min, max);
    }

    // Update an existing buffer with new data
    updateBuffer(buffer, data, target = this.gl.ARRAY_BUFFER) {
        const dataLength = data.length;
        const currentSize = this.bufferSizes.get(buffer);
        
        this.gl.bindBuffer(target, buffer);
        
        // If the new data fits in the existing buffer, reuse it without reallocation
        if (currentSize >= dataLength) {
            if (target === this.gl.ARRAY_BUFFER) {
                this.gl.bufferSubData(target, 0, new Float32Array(data));
            } else {
                this.gl.bufferSubData(target, 0, new Uint16Array(data));
            }
            this.bufferStats.updated++;
            return buffer;
        } 
        // Otherwise, resize the buffer (equivalent to creating a new one)
        else {
            if (target === this.gl.ARRAY_BUFFER) {
                this.gl.bufferData(target, new Float32Array(data), this.gl.STATIC_DRAW);
            } else {
                this.gl.bufferData(target, new Uint16Array(data), this.gl.STATIC_DRAW);
            }
            // Update the stored size
            this.bufferSizes.set(buffer, dataLength);
            this.bufferStats.resized++;
            return buffer;
        }
    }
    
    // Update an existing mesh with new data (faster than creating a new one)
    updateMesh(mesh, meshData) {
        const { positions, normals, colors, indices } = meshData;
        
        // Update existing buffers without creating new ones
        this.updateBuffer(mesh.position, positions);
        this.updateBuffer(mesh.normal, normals);
        this.updateBuffer(mesh.color, colors);
        this.updateBuffer(mesh.indices, indices, this.gl.ELEMENT_ARRAY_BUFFER);
        
        // Update vertex count
        mesh.vertexCount = indices.length;
        
        return mesh;
    }

    // Add instanced rendering support
    initInstancedRendering() {
        // Create cube geometry once
        const {positions, normals, indices} = this.createCubeGeometry();
        
        // Create buffers for the instanced cube
        this.instancedCube = {
            position: this.gl.createBuffer(),
            normal: this.gl.createBuffer(),
            indices: this.gl.createBuffer(),
            // Buffers for per-instance data
            instancePositions: this.gl.createBuffer(),
            instanceColors: this.gl.createBuffer(),
            // Geometry info
            vertexCount: indices.length
        };
        
        // Upload the geometry data (done once)
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instancedCube.position);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(positions), this.gl.STATIC_DRAW);
        
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instancedCube.normal);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(normals), this.gl.STATIC_DRAW);
        
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.instancedCube.indices);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), this.gl.STATIC_DRAW);
        
        // Create and link the instanced rendering shader
        this.initInstancedShader();
    }

    // Create a standard cube geometry
    createCubeGeometry() {
        // Basic unit cube vertices
        const positions = [
            // Front face
            -0.5, -0.5,  0.5,
             0.5, -0.5,  0.5,
             0.5,  0.5,  0.5,
            -0.5,  0.5,  0.5,
            // Back face
            -0.5, -0.5, -0.5,
            -0.5,  0.5, -0.5,
             0.5,  0.5, -0.5,
             0.5, -0.5, -0.5,
            // Top face
            -0.5,  0.5, -0.5,
            -0.5,  0.5,  0.5,
             0.5,  0.5,  0.5,
             0.5,  0.5, -0.5,
            // Bottom face
            -0.5, -0.5, -0.5,
             0.5, -0.5, -0.5,
             0.5, -0.5,  0.5,
            -0.5, -0.5,  0.5,
            // Right face
             0.5, -0.5, -0.5,
             0.5,  0.5, -0.5,
             0.5,  0.5,  0.5,
             0.5, -0.5,  0.5,
            // Left face
            -0.5, -0.5, -0.5,
            -0.5, -0.5,  0.5,
            -0.5,  0.5,  0.5,
            -0.5,  0.5, -0.5,
        ];
        
        // Normals for each vertex
        const normals = [
            // Front face
            0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
            // Back face
            0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
            // Top face
            0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
            // Bottom face
            0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
            // Right face
            1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
            // Left face
            -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
        ];
        
        // Indices for the cube
        const indices = [
            0, 1, 2,    0, 2, 3,    // Front face
            4, 5, 6,    4, 6, 7,    // Back face
            8, 9, 10,   8, 10, 11,  // Top face
            12, 13, 14, 12, 14, 15, // Bottom face
            16, 17, 18, 16, 18, 19, // Right face
            20, 21, 22, 20, 22, 23  // Left face
        ];
        
        return {positions, normals, indices};
    }

    // Initialize instanced rendering shader
    initInstancedShader() {
        const vsSource = `
            attribute vec4 aVertexPosition;
            attribute vec3 aVertexNormal;
            
            // Per-instance attributes
            attribute vec3 aInstancePosition;
            attribute vec4 aInstanceColor;
            
            uniform mat4 uProjectionMatrix;
            uniform mat4 uViewMatrix;
            uniform mat4 uNormalMatrix;
            
            varying highp vec3 vNormal;
            varying highp vec4 vColor;
            varying highp vec3 vPosition;
            
            void main() {
                // Calculate position based on instance position
                vec4 worldPosition = vec4(
                    aVertexPosition.xyz + aInstancePosition,
                    1.0
                );
                
                gl_Position = uProjectionMatrix * uViewMatrix * worldPosition;
                vNormal = (uNormalMatrix * vec4(aVertexNormal, 0.0)).xyz;
                vColor = aInstanceColor;
                vPosition = worldPosition.xyz;
            }
        `;
        
        const fsSource = `
            precision highp float;
            
            varying highp vec3 vNormal;
            varying highp vec4 vColor;
            varying highp vec3 vPosition;
            
            uniform vec3 uLightDirection;
            uniform float uAmbient;
            
            void main() {
                // Calculate lighting
                vec3 normal = normalize(vNormal);
                vec3 lightDir = normalize(uLightDirection);
                
                // Basic diffuse lighting
                float diffuse = max(dot(normal, lightDir), 0.0);
                
                // Add ambient light
                float ambient = uAmbient;
                
                // Add more depth with hemisphere lighting (sky/ground)
                float hemisphereLight = 0.5 + 0.5 * normal.y;
                float lighting = diffuse * 0.7 + ambient + hemisphereLight * 0.3;
                
                // Apply lighting to color (preserve alpha)
                vec4 litColor = vec4(vColor.rgb * lighting, vColor.a);
                
                // Apply slight distance fog for depth perception
                float fogStart = 32.0;
                float fogEnd = 128.0;
                float fogDensity = 0.02;
                
                // Calculate fog amount
                float fogDistance = length(vPosition);
                float fogAmount = clamp((fogDistance - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
                fogAmount = fogAmount * fogAmount; // Square for smoother transition
                
                // Blend with fog color (light blue sky color)
                vec4 fogColor = vec4(0.6, 0.8, 1.0, 1.0);
                litColor = mix(litColor, fogColor, fogAmount * min(1.0, vColor.a));
                
                gl_FragColor = litColor;
            }
        `;
        
        // Create the shader program
        const shaderProgram = this.initShaderProgram(vsSource, fsSource);
        
        this.instancedProgramInfo = {
            program: shaderProgram,
            attribLocations: {
                vertexPosition: this.gl.getAttribLocation(shaderProgram, 'aVertexPosition'),
                vertexNormal: this.gl.getAttribLocation(shaderProgram, 'aVertexNormal'),
                instancePosition: this.gl.getAttribLocation(shaderProgram, 'aInstancePosition'),
                instanceColor: this.gl.getAttribLocation(shaderProgram, 'aInstanceColor'),
            },
            uniformLocations: {
                projectionMatrix: this.gl.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
                viewMatrix: this.gl.getUniformLocation(shaderProgram, 'uViewMatrix'),
                normalMatrix: this.gl.getUniformLocation(shaderProgram, 'uNormalMatrix'),
                lightDirection: this.gl.getUniformLocation(shaderProgram, 'uLightDirection'),
                ambient: this.gl.getUniformLocation(shaderProgram, 'uAmbient'),
            },
        };
    }

    // Render voxels using instanced rendering
    renderVoxelsInstanced(voxels, projectionMatrix, viewMatrix) {
        // Skip if no voxels or instanced rendering not supported
        if (!this.supportsInstancedRendering || voxels.length === 0) {
            return 0;
        }
        
        const gl = this.gl;
        
        // Enable depth testing and alpha blending
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        
        // Bind shader
        gl.useProgram(this.instancedProgramInfo.program);
        
        // Set matrices
        gl.uniformMatrix4fv(
            this.instancedProgramInfo.uniformLocations.projectionMatrix,
            false,
            projectionMatrix
        );
        gl.uniformMatrix4fv(
            this.instancedProgramInfo.uniformLocations.viewMatrix,
            false,
            viewMatrix
        );
        
        // Calculate and set normal matrix (for proper lighting)
        const normalMatrix = mat4.create();
        mat4.invert(normalMatrix, viewMatrix);
        mat4.transpose(normalMatrix, normalMatrix);
        gl.uniformMatrix4fv(
            this.instancedProgramInfo.uniformLocations.normalMatrix,
            false,
            normalMatrix
        );
        
        // Bind cube geometry
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instancedCube.position);
        gl.vertexAttribPointer(
            this.instancedProgramInfo.attribLocations.vertexPosition,
            3,
            gl.FLOAT,
            false,
            0,
            0
        );
        gl.enableVertexAttribArray(this.instancedProgramInfo.attribLocations.vertexPosition);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instancedCube.normal);
        gl.vertexAttribPointer(
            this.instancedProgramInfo.attribLocations.vertexNormal,
            3,
            gl.FLOAT,
            false,
            0,
            0
        );
        gl.enableVertexAttribArray(this.instancedProgramInfo.attribLocations.vertexNormal);
        
        // Set up instance data
        const instancePositions = new Float32Array(voxels.length * 3);
        const instanceColors = new Float32Array(voxels.length * 4);
        
        // Fill instance data arrays
        for (let i = 0; i < voxels.length; i++) {
            const voxel = voxels[i];
            instancePositions[i * 3] = voxel.x;
            instancePositions[i * 3 + 1] = voxel.y;
            instancePositions[i * 3 + 2] = voxel.z;
            
            // Get color from voxel - handle both direct color and type-based color
            let color = voxel.color;
            if (!color && voxel.type) {
                color = this.getVoxelColor(voxel.type);
            }
            
            if (color) {
                instanceColors[i * 4] = color.r;
                instanceColors[i * 4 + 1] = color.g;
                instanceColors[i * 4 + 2] = color.b;
                instanceColors[i * 4 + 3] = color.a || 1.0;
            } else {
                // Default pink color if missing
                instanceColors[i * 4] = 1.0;
                instanceColors[i * 4 + 1] = 0.0;
                instanceColors[i * 4 + 2] = 1.0;
                instanceColors[i * 4 + 3] = 1.0;
            }
        }
        
        // Buffer positions
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instancedCube.instancePositions);
        gl.bufferData(gl.ARRAY_BUFFER, instancePositions, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(
            this.instancedProgramInfo.attribLocations.instancePosition,
            3,
            gl.FLOAT,
            false,
            0,
            0
        );
        gl.enableVertexAttribArray(this.instancedProgramInfo.attribLocations.instancePosition);
        this.gl.vertexAttribDivisor(this.instancedProgramInfo.attribLocations.instancePosition, 1);
        
        // Buffer colors
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instancedCube.instanceColors);
        gl.bufferData(gl.ARRAY_BUFFER, instanceColors, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(
            this.instancedProgramInfo.attribLocations.instanceColor,
            4,
            gl.FLOAT,
            false,
            0,
            0
        );
        gl.enableVertexAttribArray(this.instancedProgramInfo.attribLocations.instanceColor);
        this.gl.vertexAttribDivisor(this.instancedProgramInfo.attribLocations.instanceColor, 1);
        
        // Set lighting parameters
        gl.uniform3fv(this.instancedProgramInfo.uniformLocations.lightDirection, 
                     [0.5, 1.0, 0.8]); // Light coming from top-right
        gl.uniform1f(this.instancedProgramInfo.uniformLocations.ambient, 0.3); // Ambient light level
        
        // Bind cube indices
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.instancedCube.indices);
        
        // Draw the instances
        this.gl.drawElementsInstanced(
            gl.TRIANGLES,
            36,  // 6 faces * 2 triangles * 3 vertices
            gl.UNSIGNED_SHORT,
            0,
            voxels.length
        );
        
        // Cleanup attributes
        gl.disableVertexAttribArray(this.instancedProgramInfo.attribLocations.vertexPosition);
        gl.disableVertexAttribArray(this.instancedProgramInfo.attribLocations.vertexNormal);
        gl.disableVertexAttribArray(this.instancedProgramInfo.attribLocations.instancePosition);
        gl.disableVertexAttribArray(this.instancedProgramInfo.attribLocations.instanceColor);
        this.gl.vertexAttribDivisor(this.instancedProgramInfo.attribLocations.instancePosition, 0);
        this.gl.vertexAttribDivisor(this.instancedProgramInfo.attribLocations.instanceColor, 0);
        
        gl.disable(gl.BLEND);
        
        return voxels.length;
    }

    // Get color from voxel type
    getVoxelColor(voxelType) {
        // Basic color palette
        switch(voxelType) {
            case VoxelType.AIR: 
                return {r: 0.0, g: 0.0, b: 0.0, a: 0.0}; // Air (invisible)
            case VoxelType.GRASS: 
                return {r: 0.3, g: 0.75, b: 0.3, a: 1.0}; // Grass (green)
            case VoxelType.BEDROCK: 
                return {r: 0.2, g: 0.2, b: 0.2, a: 1.0}; // Bedrock (dark gray)
            case VoxelType.STONE: 
                return {r: 0.5, g: 0.5, b: 0.5, a: 1.0}; // Stone (gray)
            case VoxelType.DIRT: 
                return {r: 0.5, g: 0.3, b: 0.1, a: 1.0}; // Dirt (brown)
            case VoxelType.WATER: 
                return {r: 0.0, g: 0.3, b: 0.8, a: 0.7}; // Water (blue, transparent)
            default: 
                return {r: 1.0, g: 0.0, b: 1.0, a: 1.0}; // Missing texture (pink)
        }
    }

    // Provide a method to get buffer statistics
    getBufferStats() {
        return { ...this.bufferStats };
    }

    // Force cleanup of buffer pools (call when memory is high)
    forceBufferCleanup(aggressiveMode = false) {
        // Use an aggressive max pool size when memory is tight
        const maxPoolSize = aggressiveMode ? 10 : 20;
        
        console.log(`Force buffer cleanup (aggressive: ${aggressiveMode})`);
        const cleaned = this.cleanupBufferPools(maxPoolSize);
        
        // If in aggressive mode, completely flush out some pools
        if (aggressiveMode && this.totalPoolSize() > 50) {
            // Delete ALL index buffers - they're generally small and easy to recreate
            this.flushBufferPool('indices');
            
            // Also try to delete the largest 50% of buffers from each pool
            this.pruneBufferPoolsBySize('vertices', 0.5);
            this.pruneBufferPoolsBySize('normals', 0.5);
            this.pruneBufferPoolsBySize('colors', 0.5);
            
            console.log('Aggressive buffer cleanup complete');
        }
        
        return cleaned;
    }

    // Calculate total number of buffers in all pools
    totalPoolSize() {
        return Object.values(this.bufferPools).reduce((sum, pool) => sum + pool.length, 0);
    }

    // Completely flush a specific buffer pool
    flushBufferPool(type) {
        const count = this.bufferPools[type].length;
        
        if (count > 0) {
            console.log(`Flushing ${count} buffers from ${type} pool`);
            
            // Delete all buffers in the pool
            this.bufferPools[type].forEach(buffer => {
                this.gl.deleteBuffer(buffer);
                this.bufferSizes.delete(buffer);
            });
            
            // Clear the pool
            this.bufferPools[type] = [];
        }
    }

    // Prune a buffer pool by removing the largest buffers
    pruneBufferPoolsBySize(type, percentToRemove = 0.5) {
        const pool = this.bufferPools[type];
        if (pool.length <= 5) return; // Don't prune very small pools
        
        // First, get all buffers with their sizes
        const buffersWithSizes = pool.map(buffer => ({
            buffer,
            size: this.bufferSizes.get(buffer) || 0
        }));
        
        // Sort by size, largest first
        buffersWithSizes.sort((a, b) => b.size - a.size);
        
        // Determine how many to remove
        const numToRemove = Math.ceil(pool.length * percentToRemove);
        
        // Remove the largest buffers
        const toRemove = buffersWithSizes.slice(0, numToRemove);
        
        console.log(`Pruning ${numToRemove} largest buffers from ${type} pool`);
        
        // Delete the buffers
        toRemove.forEach(({buffer}) => {
            this.gl.deleteBuffer(buffer);
            this.bufferSizes.delete(buffer);
            
            // Remove from the pool
            const index = pool.indexOf(buffer);
            if (index !== -1) {
                pool.splice(index, 1);
            }
        });
    }

    // A more forgiving frustum check that allows some margin
    isBoxInFrustumLenient(frustum, min, max) {
        // Allow a lot of wiggle room to prevent popping
        // For each plane of the frustum
        for (let i = 0; i < frustum.length; i++) {
            const plane = frustum[i];
            
            // Check if the box is completely outside any plane
            // A box is outside if all 8 corners are outside
            let allCornersOutside = true;
            
            // Test each corner of the box against this plane
            // We need at least one corner inside to keep the chunk
            for (let x = 0; x <= 1; x++) {
                for (let y = 0; y <= 1; y++) {
                    for (let z = 0; z <= 1; z++) {
                        // Calculate corner position
                        const cornerX = x === 0 ? min[0] : max[0];
                        const cornerY = y === 0 ? min[1] : max[1];
                        const cornerZ = z === 0 ? min[2] : max[2];
                        
                        // Distance from corner to plane
                        const distance = 
                            plane[0] * cornerX +
                            plane[1] * cornerY +
                            plane[2] * cornerZ +
                            plane[3];
                        
                        // If at least one corner is inside or on the plane, not all corners are outside
                        // Use a much larger negative buffer (-16) to ensure chunks don't pop in and out
                        if (distance >= -16) { // Greatly increased the buffer from -8 to -16
                            allCornersOutside = false;
                            break;
                        }
                    }
                    if (!allCornersOutside) break;
                }
                if (!allCornersOutside) break;
            }
            
            // Skip the far plane check entirely to prevent chunks from being culled in the distance
            if (i === 5) { // Far plane is typically the 6th plane (index 5)
                continue;
            }
            
            // If all corners are outside this plane, the box is outside the frustum
            if (allCornersOutside) {
                return false;
            }
        }
        
        // If we got here, the box is either inside or intersects the frustum
        return true;
    }

    // Render wireframe boxes around chunks for debugging
    renderChunkBoundaries(chunks, projectionMatrix, viewMatrix) {
        // Skip if no chunks to render
        if (chunks.length === 0) return;
        
        // Create line program if it doesn't exist
        if (!this.lineProgram) {
            const vsSource = `
                attribute vec3 aPosition;
                attribute vec4 aColor;
                
                uniform mat4 uProjectionMatrix;
                uniform mat4 uViewMatrix;
                
                varying highp vec4 vColor;
                
                void main() {
                    gl_Position = uProjectionMatrix * uViewMatrix * vec4(aPosition, 1.0);
                    vColor = aColor;
                }
            `;
            
            const fsSource = `
                precision highp float;
                varying highp vec4 vColor;
                
                void main() {
                    gl_FragColor = vColor;
                }
            `;
            
            this.lineProgram = this.initShaderProgram(vsSource, fsSource);
            if (!this.lineProgram) return;
            
            this.lineProgramInfo = {
                program: this.lineProgram,
                attribLocations: {
                    position: this.gl.getAttribLocation(this.lineProgram, 'aPosition'),
                    color: this.gl.getAttribLocation(this.lineProgram, 'aColor')
                },
                uniformLocations: {
                    projectionMatrix: this.gl.getUniformLocation(this.lineProgram, 'uProjectionMatrix'),
                    viewMatrix: this.gl.getUniformLocation(this.lineProgram, 'uViewMatrix')
                }
            };
        }
        
        // Use the line shader program
        this.gl.useProgram(this.lineProgramInfo.program);
        
        // Set projection and view matrices
        this.gl.uniformMatrix4fv(
            this.lineProgramInfo.uniformLocations.projectionMatrix,
            false,
            projectionMatrix
        );
        
        this.gl.uniformMatrix4fv(
            this.lineProgramInfo.uniformLocations.viewMatrix,
            false,
            viewMatrix
        );
        
        // For each chunk, render its bounding box
        for (const chunk of chunks) {
            const position = chunk.worldOffset || [0, 0, 0];
            this.renderChunkWireframe(position, [1, 1, 0, 0.5]); // Yellow wireframes
        }
    }
    
    // Render a wireframe box for a single chunk
    renderChunkWireframe(position, color) {
        const x = position[0];
        const y = position[1];
        const z = position[2];
        const size = CHUNK_SIZE;
        
        // Create vertices for a cube wireframe (12 lines, 2 points each)
        const vertices = [
            // Bottom face
            x, y, z,           x + size, y, z,
            x + size, y, z,    x + size, y, z + size,
            x + size, y, z + size, x, y, z + size,
            x, y, z + size,    x, y, z,
            
            // Top face
            x, y + size, z,    x + size, y + size, z,
            x + size, y + size, z, x + size, y + size, z + size,
            x + size, y + size, z + size, x, y + size, z + size,
            x, y + size, z + size, x, y + size, z,
            
            // Vertical edges
            x, y, z,           x, y + size, z,
            x + size, y, z,    x + size, y + size, z,
            x + size, y, z + size, x + size, y + size, z + size,
            x, y, z + size,    x, y + size, z + size
        ];
        
        // Create colors for each vertex
        const colors = [];
        for (let i = 0; i < vertices.length / 3; i++) {
            colors.push(color[0], color[1], color[2], color[3]);
        }
        
        // Create buffers
        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.STATIC_DRAW);
        
        const colorBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(colors), this.gl.STATIC_DRAW);
        
        // Bind position buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.vertexAttribPointer(
            this.lineProgramInfo.attribLocations.position,
            3,
            this.gl.FLOAT,
            false,
            0,
            0
        );
        this.gl.enableVertexAttribArray(this.lineProgramInfo.attribLocations.position);
        
        // Bind color buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
        this.gl.vertexAttribPointer(
            this.lineProgramInfo.attribLocations.color,
            4,
            this.gl.FLOAT,
            false,
            0,
            0
        );
        this.gl.enableVertexAttribArray(this.lineProgramInfo.attribLocations.color);
        
        // Draw the lines
        this.gl.lineWidth(2.0); // Set line width
        this.gl.drawArrays(this.gl.LINES, 0, vertices.length / 3);
        
        // Clean up
        this.gl.deleteBuffer(positionBuffer);
        this.gl.deleteBuffer(colorBuffer);
    }
}