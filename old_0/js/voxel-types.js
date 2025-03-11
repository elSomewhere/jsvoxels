export const VoxelType = {
    AIR: 0,
    GRASS: 1,
    BEDROCK: 2,
    STONE: 3,
    DIRT: 4,
    WATER: 5
};

export class VoxelTypeManager {
    constructor(textureAtlas = null) {
        this.types = new Map();
        this.textureAtlas = textureAtlas;
        this.useTextures = textureAtlas !== null;
        this.setupDefaultTypes();
    }

    setupDefaultTypes() {
        // Air
        this.registerType(VoxelType.AIR, {
            name: "Air",
            transparent: true,
            solid: false,
            getColor: () => [0, 0, 0, 0],
            textureMapping: {
                all: { tileX: 0, tileY: 0 }
            }
        });

        // Grass
        this.registerType(VoxelType.GRASS, {
            name: "Grass",
            transparent: false,
            solid: true,
            getColor: (face) => {
                if (face === 'top') return [0.3, 0.75, 0.3, 1.0]; // Top - green
                if (face === 'bottom') return [0.5, 0.3, 0.1, 1.0]; // Bottom - dirt color
                return [0.4, 0.5, 0.2, 1.0]; // Sides - grass side
            },
            textureMapping: {
                top: { tileX: 0, tileY: 0 },
                side: { tileX: 1, tileY: 0 },
                bottom: { tileX: 2, tileY: 0 }
            }
        });

        // Bedrock
        this.registerType(VoxelType.BEDROCK, {
            name: "Bedrock",
            transparent: false,
            solid: true,
            getColor: () => [0.2, 0.2, 0.2, 1.0],
            textureMapping: {
                all: { tileX: 4, tileY: 0 }
            }
        });

        // Stone
        this.registerType(VoxelType.STONE, {
            name: "Stone",
            transparent: false,
            solid: true,
            getColor: () => [0.5, 0.5, 0.5, 1.0],
            textureMapping: {
                all: { tileX: 3, tileY: 0 }
            }
        });

        // Dirt
        this.registerType(VoxelType.DIRT, {
            name: "Dirt",
            transparent: false,
            solid: true,
            getColor: () => [0.5, 0.3, 0.1, 1.0],
            textureMapping: {
                all: { tileX: 2, tileY: 0 }
            }
        });

        // Water
        this.registerType(VoxelType.WATER, {
            name: "Water",
            transparent: true,
            solid: true, // Semi-solid for physics
            getColor: () => [0.0, 0.3, 0.8, 0.7],
            textureMapping: {
                all: { tileX: 5, tileY: 0 }
            }
        });
    }

    registerType(id, properties) {
        this.types.set(id, properties);
    }

    getType(id) {
        return this.types.get(id) || this.types.get(VoxelType.AIR);
    }

    isTransparent(id) {
        const type = this.getType(id);
        return type.transparent;
    }

    isSolid(id) {
        const type = this.getType(id);
        return type.solid;
    }

    getColor(id, face) {
        const type = this.getType(id);
        return type.getColor(face);
    }

    // Get texture mapping for a voxel type and face
    getTextureMapping(id, face) {
        const type = this.getType(id);

        if (!type.textureMapping) {
            return null;
        }

        // First check for specific face mapping
        if (type.textureMapping[face]) {
            return type.textureMapping[face];
        }

        // Fall back to 'all' mapping
        if (type.textureMapping.all) {
            return type.textureMapping.all;
        }

        return null;
    }

    // Get serializable texture data for workers
    getSerializableTextureData() {
        const texData = {};

        for (const [id, type] of this.types.entries()) {
            if (type.textureMapping) {
                texData[id] = type.textureMapping;
            }
        }

        return texData;
    }
}