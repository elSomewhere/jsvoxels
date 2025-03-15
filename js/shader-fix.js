/**
 * Shader fix module - corrected GLSL shaders for WebGL2
 */

// Main vertex shader for WebGL2
export const mainVertexShaderWebGL2 = `#version 300 es
in vec4 aVertexPosition;
in vec3 aVertexNormal;
in vec4 aVertexColor;

uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform mat4 uNormalMatrix;

out highp vec3 vNormal;
out highp vec4 vColor;

void main(void) {
    gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
    vNormal = (uNormalMatrix * vec4(aVertexNormal, 0.0)).xyz;
    vColor = aVertexColor;
}`;

// Main fragment shader for WebGL2
export const mainFragmentShaderWebGL2 = `#version 300 es
precision highp float;

in highp vec3 vNormal;
in highp vec4 vColor;

uniform vec3 uLightDirection;

out vec4 fragColor;

void main(void) {
    // Calculate lighting
    vec3 normal = normalize(vNormal);
    vec3 lightDir = normalize(uLightDirection);
    float diffuse = max(dot(normal, lightDir), 0.0);
    
    // Add ambient light
    float ambient = 0.3;
    float lighting = diffuse + ambient;
    
    // Apply lighting to color (preserve alpha)
    fragColor = vec4(vColor.rgb * lighting, vColor.a);
}`;

// Instanced vertex shader for WebGL2
export const instancedVertexShaderWebGL2 = `#version 300 es
in vec4 aVertexPosition;
in vec3 aVertexNormal;

// Per-instance attributes
in vec3 aInstancePosition;
in vec4 aInstanceColor;

uniform mat4 uProjectionMatrix;
uniform mat4 uViewMatrix;
uniform mat4 uNormalMatrix;

out highp vec3 vNormal;
out highp vec4 vColor;
out highp vec3 vPosition;

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
}`;

// Instanced fragment shader for WebGL2
export const instancedFragmentShaderWebGL2 = `#version 300 es
precision highp float;

in highp vec3 vNormal;
in highp vec4 vColor;
in highp vec3 vPosition;

uniform vec3 uLightDirection;
uniform float uAmbient;

out vec4 fragColor;

void main() {
    // Calculate lighting
    vec3 normal = normalize(vNormal);
    vec3 lightDir = normalize(uLightDirection);
    
    // Diffuse lighting calculation
    float diffuse = max(dot(normal, lightDir), 0.0);
    
    // Apply lighting with ambient
    float lighting = diffuse + uAmbient;
    
    // Apply lighting to color
    fragColor = vec4(vColor.rgb * lighting, vColor.a);
}`;

// Main vertex shader for WebGL1
export const mainVertexShaderWebGL1 = `
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
}`;

// Main fragment shader for WebGL1
export const mainFragmentShaderWebGL1 = `
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
}`; 