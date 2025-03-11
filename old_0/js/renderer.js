import { DEBUG } from './constants.js';
import { mat4, debugLog } from './math-utils.js';

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl');

        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        this.programInfo = null;
        this.initWebGL();
    }

    // Initialize WebGL
    initWebGL() {
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
                vec4 litColor = vec4(vColor.rgb * lighting, vColor.a);
                
                gl_FragColor = litColor;
            }
        `;

        // Initialize the shader program
        const shaderProgram = this.initShaderProgram(vsSource, fsSource);

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
            },
        };

        debugLog('WebGL initialized');
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

    // Create a mesh in WebGL
    createMesh(meshData, worldOffset) {
        const { positions, normals, colors, indices } = meshData;

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

        // Return mesh object
        return {
            position: positionBuffer,
            normal: normalBuffer,
            color: colorBuffer,
            indices: indexBuffer,
            vertexCount: indices.length,
            worldOffset
        };
    }

    // Delete a mesh
    deleteMesh(mesh) {
        this.gl.deleteBuffer(mesh.position);
        this.gl.deleteBuffer(mesh.normal);
        this.gl.deleteBuffer(mesh.color);
        this.gl.deleteBuffer(mesh.indices);
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

    // Render all chunks
    renderChunks(meshes, projectionMatrix, viewMatrix) {
        // Set up alpha blending for transparent blocks
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        // Use the shader program
        this.gl.useProgram(this.programInfo.program);

        // Set light direction
        this.gl.uniform3fv(this.programInfo.uniformLocations.lightDirection, [0.5, 1.0, 0.3]);

        // Draw each mesh
        let drawnChunks = 0;

        for (const mesh of meshes) {
            // Skip empty meshes
            if (mesh.vertexCount === 0) continue;

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

            // Bind index buffer
            this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, mesh.indices);

            // Set uniforms
            this.gl.uniformMatrix4fv(
                this.programInfo.uniformLocations.projectionMatrix,
                false, projectionMatrix);
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

            drawnChunks++;
        }

        this.gl.disable(this.gl.BLEND);
        return drawnChunks;
    }
}