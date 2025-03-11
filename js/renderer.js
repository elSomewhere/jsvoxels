import { DEBUG, ENABLE_FRUSTUM_CULLING, DEBUG_FRUSTUM_CULLING } from './constants.js';
import { mat4, debugLog } from './math-utils.js';
import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl');
        this.bufferManager = null; // Will be set by main.js

        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        this.programInfo = null;
        this.texturedProgramInfo = null;
        this.currentFrustum = null;
        this.initWebGL();
    }

    // Set the buffer manager
    setBufferManager(bufferManager) {
        this.bufferManager = bufferManager;
    }

    // Initialize WebGL
    initWebGL() {
        // Create basic shaders for colored voxels
        const vsSource = `
            attribute vec4 aVertexPosition;
            attribute vec3 aVertexNormal;
            attribute vec4 aVertexColor;

            uniform mat4 uModelViewMatrix;
            uniform mat4 uProjectionMatrix;
            uniform mat4 uNormalMatrix;

            varying highp vec3 vNormal;
            varying highp vec4 vColor;
            varying highp vec3 vPosition;

            void main(void) {
                gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
                vNormal = (uNormalMatrix * vec4(aVertexNormal, 0.0)).xyz;
                vColor = aVertexColor;
                vPosition = (uModelViewMatrix * aVertexPosition).xyz;
            }
        `;

        const fsSource = `
            precision highp float;
            
            varying highp vec3 vNormal;
            varying highp vec4 vColor;
            varying highp vec3 vPosition;
            
            uniform vec3 uLightDirection;
            uniform vec3 uViewPosition;
            uniform float uFogNear;
            uniform float uFogFar;
            uniform vec3 uFogColor;
            
            void main(void) {
                // Calculate lighting
                vec3 normal = normalize(vNormal);
                vec3 lightDir = normalize(uLightDirection);
                float diffuse = max(dot(normal, lightDir), 0.0);
                
                // Add ambient light
                float ambient = 0.3;
                float lighting = diffuse + ambient;
                
                // Apply lighting to color (preserve alpha)
                vec4 litColor = vec4(vColor.rgb * lighting, vColor.a);
                
                // Apply fog effect
                float dist = length(vPosition);
                float fogFactor = smoothstep(uFogNear, uFogFar, dist);
                vec3 finalColor = mix(litColor.rgb, uFogColor, fogFactor);
                
                gl_FragColor = vec4(finalColor, litColor.a);
            }
        `;

        // Create textured shader program
        const texturedVsSource = `
            attribute vec4 aVertexPosition;
            attribute vec3 aVertexNormal;
            attribute vec2 aTextureCoord;

            uniform mat4 uModelViewMatrix;
            uniform mat4 uProjectionMatrix;
            uniform mat4 uNormalMatrix;

            varying highp vec3 vNormal;
            varying highp vec2 vTextureCoord;
            varying highp vec3 vPosition;

            void main(void) {
                gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
                vNormal = (uNormalMatrix * vec4(aVertexNormal, 0.0)).xyz;
                vTextureCoord = aTextureCoord;
                vPosition = (uModelViewMatrix * aVertexPosition).xyz;
            }
        `;

        const texturedFsSource = `
            precision highp float;
            
            varying highp vec3 vNormal;
            varying highp vec2 vTextureCoord;
            varying highp vec3 vPosition;
            
            uniform sampler2D uSampler;
            uniform vec3 uLightDirection;
            uniform vec3 uViewPosition;
            uniform float uFogNear;
            uniform float uFogFar;
            uniform vec3 uFogColor;
            
            void main(void) {
                // Get texture color
                vec4 texColor = texture2D(uSampler, vTextureCoord);
                
                // Skip transparent pixels
                if (texColor.a < 0.1) {
                    discard;
                }
                
                // Calculate lighting
                vec3 normal = normalize(vNormal);
                vec3 lightDir = normalize(uLightDirection);
                float diffuse = max(dot(normal, lightDir), 0.0);
                
                // Add ambient light
                float ambient = 0.3;
                float lighting = diffuse + ambient;
                
                // Apply lighting to texture
                vec4 litColor = vec4(texColor.rgb * lighting, texColor.a);
                
                // Apply fog effect
                float dist = length(vPosition);
                float fogFactor = smoothstep(uFogNear, uFogFar, dist);
                vec3 finalColor = mix(litColor.rgb, uFogColor, fogFactor);
                
                gl_FragColor = vec4(finalColor, litColor.a);
            }
        `;

        // Initialize the shader programs
        const shaderProgram = this.initShaderProgram(vsSource, fsSource);
        const texturedShaderProgram = this.initShaderProgram(texturedVsSource, texturedFsSource);

        // Store program info
        this.programInfo = {
            program: shaderProgram,
            attribLocations: {
                vertexPosition: this.gl.getAttribLocation(shaderProgram, 'aVertexPosition'),
                vertexNormal: this.gl.getAttribLocation(shaderProgram, 'aVertexNormal'),
                vertexColor: this.gl.getAttribLocation(shaderProgram, 'aVertexColor'),
            },
            uniformLocations: {
                projectionMatrix: this.gl.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
                modelViewMatrix: this.gl.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
                normalMatrix: this.gl.getUniformLocation(shaderProgram, 'uNormalMatrix'),
                lightDirection: this.gl.getUniformLocation(shaderProgram, 'uLightDirection'),
                viewPosition: this.gl.getUniformLocation(shaderProgram, 'uViewPosition'),
                fogNear: this.gl.getUniformLocation(shaderProgram, 'uFogNear'),
                fogFar: this.gl.getUniformLocation(shaderProgram, 'uFogFar'),
                fogColor: this.gl.getUniformLocation(shaderProgram, 'uFogColor'),
            },
        };

        this.texturedProgramInfo = {
            program: texturedShaderProgram,
            attribLocations: {
                vertexPosition: this.gl.getAttribLocation(texturedShaderProgram, 'aVertexPosition'),
                vertexNormal: this.gl.getAttribLocation(texturedShaderProgram, 'aVertexNormal'),
                textureCoord: this.gl.getAttribLocation(texturedShaderProgram, 'aTextureCoord'),
            },
            uniformLocations: {
                projectionMatrix: this.gl.getUniformLocation(texturedShaderProgram, 'uProjectionMatrix'),
                modelViewMatrix: this.gl.getUniformLocation(texturedShaderProgram, 'uModelViewMatrix'),
                normalMatrix: this.gl.getUniformLocation(texturedShaderProgram, 'uNormalMatrix'),
                sampler: this.gl.getUniformLocation(texturedShaderProgram, 'uSampler'),
                lightDirection: this.gl.getUniformLocation(texturedShaderProgram, 'uLightDirection'),
                viewPosition: this.gl.getUniformLocation(texturedShaderProgram, 'uViewPosition'),
                fogNear: this.gl.getUniformLocation(texturedShaderProgram, 'uFogNear'),
                fogFar: this.gl.getUniformLocation(texturedShaderProgram, 'uFogFar'),
                fogColor: this.gl.getUniformLocation(texturedShaderProgram, 'uFogColor'),
            },
        };

        debugLog('WebGL initialized with shaders');
    }

    // Create a shader program
    initShaderProgram(vsSource, fsSource) {
        const vertexShader = this.loadShader(this.gl.VERTEX_SHADER, vsSource);
        const fragmentShader = this.loadShader(this.gl.FRAGMENT_SHADER, fsSource);

        if (!vertexShader || !fragmentShader) {
            return null;
        }

        const shaderProgram = this.gl.createProgram();
        this.gl.attachShader(shaderProgram, vertexShader);
        this.gl.attachShader(shaderProgram, fragmentShader);
        this.gl.linkProgram(shaderProgram);

        if (!this.gl.getProgramParameter(shaderProgram, this.gl.LINK_STATUS)) {
            console.error('Unable to initialize shader program: ' + this.gl.getProgramInfoLog(shaderProgram));
            return null;
        }

        return shaderProgram;
    }

    // Compile a shader
    loadShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);

        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('Shader compilation error: ' + this.gl.getShaderInfoLog(shader));
            this.gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    // Create a mesh in WebGL using buffer manager
    createMesh(meshData, worldOffset, useTextures = false) {
        const { positions, normals, colors, indices, uvs } = meshData;
        const buffers = {};
        const bufferIds = [];

        // Use buffer manager if available
        if (this.bufferManager) {
            // Create position buffer
            const posBuffer = this.bufferManager.getBuffer('vertex', new Float32Array(positions));
            buffers.position = posBuffer.buffer;
            bufferIds.push(posBuffer.id);

            // Create normal buffer
            const normBuffer = this.bufferManager.getBuffer('normal', new Float32Array(normals));
            buffers.normal = normBuffer.buffer;
            bufferIds.push(normBuffer.id);

            // Create color buffer or UV buffer depending on mode
            if (useTextures && uvs && uvs.length > 0) {
                const uvBuffer = this.bufferManager.getBuffer('uv', new Float32Array(uvs));
                buffers.uv = uvBuffer.buffer;
                bufferIds.push(uvBuffer.id);
                buffers.textured = true;
            } else {
                const colorBuffer = this.bufferManager.getBuffer('color', new Float32Array(colors));
                buffers.color = colorBuffer.buffer;
                bufferIds.push(colorBuffer.id);
                buffers.textured = false;
            }

            // Create index buffer
            const idxBuffer = this.bufferManager.getBuffer('index', new Uint16Array(indices));
            buffers.indices = idxBuffer.buffer;
            bufferIds.push(idxBuffer.id);
        } else {
            // Fallback to direct buffer creation
            // Create position buffer
            const positionBuffer = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(positions), this.gl.STATIC_DRAW);
            buffers.position = positionBuffer;

            // Create normal buffer
            const normalBuffer = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(normals), this.gl.STATIC_DRAW);
            buffers.normal = normalBuffer;

            // Create color buffer or UV buffer depending on mode
            if (useTextures && uvs && uvs.length > 0) {
                const uvBuffer = this.gl.createBuffer();
                this.gl.bindBuffer(this.gl.ARRAY_BUFFER, uvBuffer);
                this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(uvs), this.gl.STATIC_DRAW);
                buffers.uv = uvBuffer;
                buffers.textured = true;
            } else {
                const colorBuffer = this.gl.createBuffer();
                this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
                this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(colors), this.gl.STATIC_DRAW);
                buffers.color = colorBuffer;
                buffers.textured = false;
            }

            // Create index buffer
            const indexBuffer = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), this.gl.STATIC_DRAW);
            buffers.indices = indexBuffer;
        }

        // Calculate tight bounds if available
        const bounds = {
            minX: worldOffset[0],
            minY: worldOffset[1],
            minZ: worldOffset[2],
            maxX: worldOffset[0] + CHUNK_SIZE,
            maxY: worldOffset[1] + CHUNK_SIZE,
            maxZ: worldOffset[2] + CHUNK_SIZE
        };

        // Return mesh object
        return {
            buffers,
            bufferIds,  // Store buffer IDs for cleanup
            vertexCount: indices.length,
            worldOffset,
            bounds,
            textured: buffers.textured
        };
    }

    // Delete a mesh
    deleteMesh(mesh) {
        if (!mesh || !mesh.buffers) return;

        if (this.bufferManager && mesh.bufferIds) {
            // Return buffers to pool
            for (const id of mesh.bufferIds) {
                this.bufferManager.releaseBuffer(id);
            }
        } else {
            // Delete buffers directly
            this.gl.deleteBuffer(mesh.buffers.position);
            this.gl.deleteBuffer(mesh.buffers.normal);

            if (mesh.buffers.color) {
                this.gl.deleteBuffer(mesh.buffers.color);
            }

            if (mesh.buffers.uv) {
                this.gl.deleteBuffer(mesh.buffers.uv);
            }

            this.gl.deleteBuffer(mesh.buffers.indices);
        }
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
    }

    // Check if a mesh is in the view frustum
    isMeshInFrustum(mesh, projViewMatrix) {
        if (!this.currentFrustum) {
            this.currentFrustum = mat4.frustumFromMatrix(projViewMatrix);
        }

        // Get the mesh bounds with a small safety margin to prevent flickering
        const SAFETY_MARGIN = 1.0; // Add 1 unit safety margin
        const bounds = mesh.bounds || {
            minX: mesh.worldOffset[0] - SAFETY_MARGIN,
            minY: mesh.worldOffset[1] - SAFETY_MARGIN,
            minZ: mesh.worldOffset[2] - SAFETY_MARGIN,
            maxX: mesh.worldOffset[0] + CHUNK_SIZE + SAFETY_MARGIN,
            maxY: mesh.worldOffset[1] + CHUNK_SIZE + SAFETY_MARGIN,
            maxZ: mesh.worldOffset[2] + CHUNK_SIZE + SAFETY_MARGIN
        };

        if (mesh.bounds) {
            // Add safety margin to existing bounds
            bounds.minX -= SAFETY_MARGIN;
            bounds.minY -= SAFETY_MARGIN;
            bounds.minZ -= SAFETY_MARGIN;
            bounds.maxX += SAFETY_MARGIN;
            bounds.maxY += SAFETY_MARGIN;
            bounds.maxZ += SAFETY_MARGIN;
        }

        const isInFrustum = mat4.isBoxInFrustum(
            this.currentFrustum,
            bounds.minX, bounds.minY, bounds.minZ,
            bounds.maxX, bounds.maxY, bounds.maxZ
        );

        // Add hysteresis for recently visible meshes to prevent flickering
        if (!isInFrustum && mesh.wasVisible) {
            // If it was visible in the last frame, keep it visible for one more frame
            mesh.visibilityCounter = (mesh.visibilityCounter || 0) + 1;
            if (mesh.visibilityCounter < 3) { // Keep visible for up to 3 frames after going out of view
                return true;
            }
            mesh.wasVisible = false;
            mesh.visibilityCounter = 0;
        } else if (isInFrustum) {
            mesh.wasVisible = true;
            mesh.visibilityCounter = 0;
        }

        return isInFrustum;
    }

    // Render chunks with frustum culling
    renderChunks(meshes, projectionMatrix, viewMatrix) {
        // Set up alpha blending for transparent blocks
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        // Create projection-view matrix for frustum culling
        const projViewMatrix = mat4.create();
        mat4.multiply(projViewMatrix, projectionMatrix, viewMatrix);

        // Reset current frustum
        this.currentFrustum = mat4.frustumFromMatrix(projViewMatrix);

        // Draw only visible meshes
        let drawnChunks = 0;
        let skippedChunks = 0;

        // Split meshes into opaque and transparent for proper rendering order
        const opaqueMeshes = [];
        const transparentMeshes = [];

        // Safety counter to detect frustum culling issues
        let visibleCount = 0;

        for (const mesh of meshes) {
            // Skip empty meshes
            if (!mesh || mesh.vertexCount === 0) continue;

            // Skip meshes outside view if frustum culling is enabled
            if (ENABLE_FRUSTUM_CULLING && !this.isMeshInFrustum(mesh, projViewMatrix)) {
                skippedChunks++;
                continue;
            }

            visibleCount++;

            // Sort by transparency
            if (mesh.transparent) {
                transparentMeshes.push(mesh);
            } else {
                opaqueMeshes.push(mesh);
            }
        }

        // Safety check: if no chunks are visible but we have chunks, 
        // the frustum culling might be broken - fallback to rendering all
        if (visibleCount === 0 && meshes.length > 0) {
            console.warn('Frustum culling may have failed - no visible chunks. Rendering all chunks.');
            for (const mesh of meshes) {
                if (!mesh || mesh.vertexCount === 0) continue;

                if (mesh.transparent) {
                    transparentMeshes.push(mesh);
                } else {
                    opaqueMeshes.push(mesh);
                }
            }
        }

        // Draw opaque meshes first
        this.renderMeshGroup(opaqueMeshes, projectionMatrix, viewMatrix);
        drawnChunks += opaqueMeshes.length;

        // Then draw transparent meshes back-to-front
        if (transparentMeshes.length > 0) {
            // Sort transparent meshes by distance from camera (back to front)
            const cameraPosition = [
                -viewMatrix[12],
                -viewMatrix[13],
                -viewMatrix[14]
            ];

            transparentMeshes.sort((a, b) => {
                const aCenter = [
                    a.worldOffset[0] + CHUNK_SIZE / 2,
                    a.worldOffset[1] + CHUNK_SIZE / 2,
                    a.worldOffset[2] + CHUNK_SIZE / 2
                ];
                const bCenter = [
                    b.worldOffset[0] + CHUNK_SIZE / 2,
                    b.worldOffset[1] + CHUNK_SIZE / 2,
                    b.worldOffset[2] + CHUNK_SIZE / 2
                ];

                const aDistSq = Math.pow(aCenter[0] - cameraPosition[0], 2) +
                    Math.pow(aCenter[1] - cameraPosition[1], 2) +
                    Math.pow(aCenter[2] - cameraPosition[2], 2);
                const bDistSq = Math.pow(bCenter[0] - cameraPosition[0], 2) +
                    Math.pow(bCenter[1] - cameraPosition[1], 2) +
                    Math.pow(bCenter[2] - cameraPosition[2], 2);

                return bDistSq - aDistSq; // Back-to-front
            });

            this.renderMeshGroup(transparentMeshes, projectionMatrix, viewMatrix);
            drawnChunks += transparentMeshes.length;
        }

        this.gl.disable(this.gl.BLEND);
        return drawnChunks;
    }

    // Render a group of meshes with the same shader
    renderMeshGroup(meshes, projectionMatrix, viewMatrix) {
        // Skip if no meshes
        if (meshes.length === 0) return;

        // Split meshes by shader type
        const coloredMeshes = meshes.filter(m => !m.textured);
        const texturedMeshes = meshes.filter(m => m.textured);

        // Render colored meshes
        if (coloredMeshes.length > 0) {
            this.gl.useProgram(this.programInfo.program);

            // Set shared uniforms
            this.gl.uniformMatrix4fv(
                this.programInfo.uniformLocations.projectionMatrix,
                false, projectionMatrix);

            this.gl.uniform3fv(
                this.programInfo.uniformLocations.lightDirection,
                [0.5, 1.0, 0.3]);

            // Set camera position for view-dependent effects
            this.gl.uniform3fv(
                this.programInfo.uniformLocations.viewPosition,
                [-viewMatrix[12], -viewMatrix[13], -viewMatrix[14]]);

            // Set fog uniforms
            this.gl.uniform1f(
                this.programInfo.uniformLocations.fogNear,
                CHUNK_SIZE * (RENDER_DISTANCE - 2));
            this.gl.uniform1f(
                this.programInfo.uniformLocations.fogFar,
                CHUNK_SIZE * RENDER_DISTANCE);
            this.gl.uniform3fv(
                this.programInfo.uniformLocations.fogColor,
                [0.6, 0.8, 1.0]); // Sky color

            for (const mesh of coloredMeshes) {
                this.renderColoredMesh(mesh, viewMatrix);
            }
        }

        // Render textured meshes
        if (texturedMeshes.length > 0) {
            this.gl.useProgram(this.texturedProgramInfo.program);

            // Set shared uniforms
            this.gl.uniformMatrix4fv(
                this.texturedProgramInfo.uniformLocations.projectionMatrix,
                false, projectionMatrix);

            this.gl.uniform3fv(
                this.texturedProgramInfo.uniformLocations.lightDirection,
                [0.5, 1.0, 0.3]);

            // Set camera position for view-dependent effects
            this.gl.uniform3fv(
                this.texturedProgramInfo.uniformLocations.viewPosition,
                [-viewMatrix[12], -viewMatrix[13], -viewMatrix[14]]);

            // Set texture sampler
            this.gl.uniform1i(this.texturedProgramInfo.uniformLocations.sampler, 0);

            // Set fog uniforms
            this.gl.uniform1f(
                this.texturedProgramInfo.uniformLocations.fogNear,
                CHUNK_SIZE * (RENDER_DISTANCE - 2));
            this.gl.uniform1f(
                this.texturedProgramInfo.uniformLocations.fogFar,
                CHUNK_SIZE * RENDER_DISTANCE);
            this.gl.uniform3fv(
                this.texturedProgramInfo.uniformLocations.fogColor,
                [0.6, 0.8, 1.0]); // Sky color

            for (const mesh of texturedMeshes) {
                this.renderTexturedMesh(mesh, viewMatrix);
            }
        }
    }

    // Render a colored mesh
    renderColoredMesh(mesh, viewMatrix) {
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
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.buffers.position);
        this.gl.vertexAttribPointer(
            this.programInfo.attribLocations.vertexPosition,
            3, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexPosition);

        // Bind normal buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.buffers.normal);
        this.gl.vertexAttribPointer(
            this.programInfo.attribLocations.vertexNormal,
            3, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexNormal);

        // Bind color buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.buffers.color);
        this.gl.vertexAttribPointer(
            this.programInfo.attribLocations.vertexColor,
            4, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.programInfo.attribLocations.vertexColor);

        // Bind index buffer
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, mesh.buffers.indices);

        // Set uniforms
        this.gl.uniformMatrix4fv(
            this.programInfo.uniformLocations.modelViewMatrix,
            false, modelViewMatrix);
        this.gl.uniformMatrix4fv(
            this.programInfo.uniformLocations.normalMatrix,
            false, normalMatrix);

        // Draw the chunk
        this.gl.drawElements(
            this.gl.TRIANGLES,
            mesh.vertexCount,
            this.gl.UNSIGNED_SHORT,
            0);
    }

    // Render a textured mesh
    renderTexturedMesh(mesh, viewMatrix) {
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
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.buffers.position);
        this.gl.vertexAttribPointer(
            this.texturedProgramInfo.attribLocations.vertexPosition,
            3, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.texturedProgramInfo.attribLocations.vertexPosition);

        // Bind normal buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.buffers.normal);
        this.gl.vertexAttribPointer(
            this.texturedProgramInfo.attribLocations.vertexNormal,
            3, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.texturedProgramInfo.attribLocations.vertexNormal);

        // Bind UV buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, mesh.buffers.uv);
        this.gl.vertexAttribPointer(
            this.texturedProgramInfo.attribLocations.textureCoord,
            2, this.gl.FLOAT, false, 0, 0);
        this.gl.enableVertexAttribArray(this.texturedProgramInfo.attribLocations.textureCoord);

        // Bind index buffer
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, mesh.buffers.indices);

        // Set uniforms
        this.gl.uniformMatrix4fv(
            this.texturedProgramInfo.uniformLocations.modelViewMatrix,
            false, modelViewMatrix);
        this.gl.uniformMatrix4fv(
            this.texturedProgramInfo.uniformLocations.normalMatrix,
            false, normalMatrix);

        // Draw the chunk
        this.gl.drawElements(
            this.gl.TRIANGLES,
            mesh.vertexCount,
            this.gl.UNSIGNED_SHORT,
            0);
    }

    // Clean up resources
    dispose() {
        // No specific cleanup needed for now
    }
}