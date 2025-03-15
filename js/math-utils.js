import { CHUNK_SIZE, DEBUG } from './constants.js';

export const mat4 = {
    create() {
        return new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);
    },

    perspective(out, fovy, aspect, near, far) {
        const f = 1.0 / Math.tan(fovy / 2);
        out[0] = f / aspect;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        out[4] = 0;
        out[5] = f;
        out[6] = 0;
        out[7] = 0;
        out[8] = 0;
        out[9] = 0;
        out[10] = (far + near) / (near - far);
        out[11] = -1;
        out[12] = 0;
        out[13] = 0;
        out[14] = (2 * far * near) / (near - far);
        out[15] = 0;
        return out;
    },

    lookAt(out, eye, center, up) {
        let x0, x1, x2, y0, y1, y2, z0, z1, z2, len;

        // z = normalized(eye - center)
        z0 = eye[0] - center[0];
        z1 = eye[1] - center[1];
        z2 = eye[2] - center[2];

        len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
        z0 *= len;
        z1 *= len;
        z2 *= len;

        // x = normalized(cross(up, z))
        x0 = up[1] * z2 - up[2] * z1;
        x1 = up[2] * z0 - up[0] * z2;
        x2 = up[0] * z1 - up[1] * z0;

        len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
        if (!len) {
            x0 = 0;
            x1 = 0;
            x2 = 0;
        } else {
            len = 1 / len;
            x0 *= len;
            x1 *= len;
            x2 *= len;
        }

        // y = cross(z, x)
        y0 = z1 * x2 - z2 * x1;
        y1 = z2 * x0 - z0 * x2;
        y2 = z0 * x1 - z1 * x0;

        len = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
        if (!len) {
            y0 = 0;
            y1 = 0;
            y2 = 0;
        } else {
            len = 1 / len;
            y0 *= len;
            y1 *= len;
            y2 *= len;
        }

        out[0] = x0;
        out[1] = y0;
        out[2] = z0;
        out[3] = 0;
        out[4] = x1;
        out[5] = y1;
        out[6] = z1;
        out[7] = 0;
        out[8] = x2;
        out[9] = y2;
        out[10] = z2;
        out[11] = 0;
        out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
        out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
        out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
        out[15] = 1;

        return out;
    },

    invert(out, a) {
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;

        // Calculate the determinant
        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

        if (!det) {
            return null;
        }
        det = 1.0 / det;

        out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
        out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
        out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
        out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
        out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
        out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
        out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
        out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
        out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
        out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
        out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
        out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
        out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
        out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
        out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
        out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;

        return out;
    },

    translate(out, a, v) {
        const x = v[0], y = v[1], z = v[2];

        out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
        out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
        out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
        out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];

        return out;
    },

    multiply(out, a, b) {
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

        let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
        out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

        b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
        out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

        b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
        out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

        b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
        out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

        return out;
    },

    transpose(out, a) {
        if (out === a) {
            const a01 = a[1], a02 = a[2], a03 = a[3];
            const a12 = a[6], a13 = a[7];
            const a23 = a[11];

            out[1] = a[4];
            out[2] = a[8];
            out[3] = a[12];
            out[4] = a01;
            out[6] = a[9];
            out[7] = a[13];
            out[8] = a02;
            out[9] = a12;
            out[11] = a[14];
            out[12] = a03;
            out[13] = a13;
            out[14] = a23;
        } else {
            out[0] = a[0];
            out[1] = a[4];
            out[2] = a[8];
            out[3] = a[12];
            out[4] = a[1];
            out[5] = a[5];
            out[6] = a[9];
            out[7] = a[13];
            out[8] = a[2];
            out[9] = a[6];
            out[10] = a[10];
            out[11] = a[14];
            out[12] = a[3];
            out[13] = a[7];
            out[14] = a[11];
            out[15] = a[15];
        }

        return out;
    },

    frustumFromMatrix(projectionViewMatrix) {
        const frustum = {
            planes: [
                new Float32Array(4), // Left
                new Float32Array(4), // Right
                new Float32Array(4), // Bottom
                new Float32Array(4), // Top
                new Float32Array(4), // Near
                new Float32Array(4)  // Far
            ]
        };

        // Extract planes from projection-view matrix
        // Left plane
        frustum.planes[0][0] = projectionViewMatrix[3] + projectionViewMatrix[0];
        frustum.planes[0][1] = projectionViewMatrix[7] + projectionViewMatrix[4];
        frustum.planes[0][2] = projectionViewMatrix[11] + projectionViewMatrix[8];
        frustum.planes[0][3] = projectionViewMatrix[15] + projectionViewMatrix[12];

        // Right plane
        frustum.planes[1][0] = projectionViewMatrix[3] - projectionViewMatrix[0];
        frustum.planes[1][1] = projectionViewMatrix[7] - projectionViewMatrix[4];
        frustum.planes[1][2] = projectionViewMatrix[11] - projectionViewMatrix[8];
        frustum.planes[1][3] = projectionViewMatrix[15] - projectionViewMatrix[12];

        // Bottom plane
        frustum.planes[2][0] = projectionViewMatrix[3] + projectionViewMatrix[1];
        frustum.planes[2][1] = projectionViewMatrix[7] + projectionViewMatrix[5];
        frustum.planes[2][2] = projectionViewMatrix[11] + projectionViewMatrix[9];
        frustum.planes[2][3] = projectionViewMatrix[15] + projectionViewMatrix[13];

        // Top plane
        frustum.planes[3][0] = projectionViewMatrix[3] - projectionViewMatrix[1];
        frustum.planes[3][1] = projectionViewMatrix[7] - projectionViewMatrix[5];
        frustum.planes[3][2] = projectionViewMatrix[11] - projectionViewMatrix[9];
        frustum.planes[3][3] = projectionViewMatrix[15] - projectionViewMatrix[13];

        // Near plane
        frustum.planes[4][0] = projectionViewMatrix[3] + projectionViewMatrix[2];
        frustum.planes[4][1] = projectionViewMatrix[7] + projectionViewMatrix[6];
        frustum.planes[4][2] = projectionViewMatrix[11] + projectionViewMatrix[10];
        frustum.planes[4][3] = projectionViewMatrix[15] + projectionViewMatrix[14];

        // Far plane
        frustum.planes[5][0] = projectionViewMatrix[3] - projectionViewMatrix[2];
        frustum.planes[5][1] = projectionViewMatrix[7] - projectionViewMatrix[6];
        frustum.planes[5][2] = projectionViewMatrix[11] - projectionViewMatrix[10];
        frustum.planes[5][3] = projectionViewMatrix[15] - projectionViewMatrix[14];

        // Normalize planes
        for (let i = 0; i < 6; i++) {
            const length = Math.sqrt(
                frustum.planes[i][0] * frustum.planes[i][0] +
                frustum.planes[i][1] * frustum.planes[i][1] +
                frustum.planes[i][2] * frustum.planes[i][2]
            );

            frustum.planes[i][0] /= length;
            frustum.planes[i][1] /= length;
            frustum.planes[i][2] /= length;
            frustum.planes[i][3] /= length;
        }

        return frustum;
    },

    // Check if bounding box is in frustum
    isBoxInFrustum(frustum, minX, minY, minZ, maxX, maxY, maxZ) {
        for (let i = 0; i < 6; i++) {
            const plane = frustum.planes[i];

            // Find the point furthest along the normal direction
            let px, py, pz;

            if (plane[0] >= 0) {
                px = maxX;
            } else {
                px = minX;
            }

            if (plane[1] >= 0) {
                py = maxY;
            } else {
                py = minY;
            }

            if (plane[2] >= 0) {
                pz = maxZ;
            } else {
                pz = minZ;
            }

            // If the furthest point is outside, the box is outside
            const d = plane[0] * px + plane[1] * py + plane[2] * pz + plane[3];
            if (d < 0) {
                return false;
            }
        }

        return true;
    },

    // Extract frustum planes from a projection-view matrix
    frustumFromMatrix(projViewMatrix) {
        const planes = [];
        
        // Left plane
        planes.push([
            projViewMatrix[3] + projViewMatrix[0],
            projViewMatrix[7] + projViewMatrix[4],
            projViewMatrix[11] + projViewMatrix[8],
            projViewMatrix[15] + projViewMatrix[12]
        ]);
        
        // Right plane
        planes.push([
            projViewMatrix[3] - projViewMatrix[0],
            projViewMatrix[7] - projViewMatrix[4],
            projViewMatrix[11] - projViewMatrix[8],
            projViewMatrix[15] - projViewMatrix[12]
        ]);
        
        // Bottom plane
        planes.push([
            projViewMatrix[3] + projViewMatrix[1],
            projViewMatrix[7] + projViewMatrix[5],
            projViewMatrix[11] + projViewMatrix[9],
            projViewMatrix[15] + projViewMatrix[13]
        ]);
        
        // Top plane
        planes.push([
            projViewMatrix[3] - projViewMatrix[1],
            projViewMatrix[7] - projViewMatrix[5],
            projViewMatrix[11] - projViewMatrix[9],
            projViewMatrix[15] - projViewMatrix[13]
        ]);
        
        // Near plane
        planes.push([
            projViewMatrix[3] + projViewMatrix[2],
            projViewMatrix[7] + projViewMatrix[6],
            projViewMatrix[11] + projViewMatrix[10],
            projViewMatrix[15] + projViewMatrix[14]
        ]);
        
        // Far plane
        planes.push([
            projViewMatrix[3] - projViewMatrix[2],
            projViewMatrix[7] - projViewMatrix[6],
            projViewMatrix[11] - projViewMatrix[10],
            projViewMatrix[15] - projViewMatrix[14]
        ]);
        
        // Normalize the planes with safer normalization (avoid division by zero)
        for (let i = 0; i < 6; i++) {
            const length = Math.sqrt(
                planes[i][0] * planes[i][0] +
                planes[i][1] * planes[i][1] +
                planes[i][2] * planes[i][2]
            );
            
            if (length > 0.00001) { // Avoid division by zero or very small numbers
                planes[i][0] /= length;
                planes[i][1] /= length;
                planes[i][2] /= length;
                planes[i][3] /= length;
            }
        }
        
        return planes;
    }
};

export function normalizeVector(v) {
    const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (length === 0) return v;

    v[0] /= length;
    v[1] /= length;
    v[2] /= length;
    return v;
}

export function debugLog(message) {
    if (DEBUG) {
        console.log(message);
    }
}