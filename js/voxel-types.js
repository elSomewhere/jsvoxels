export const VoxelType = {
    AIR: 0,
    GRASS: 1,
    BEDROCK: 2,
    STONE: 3,
    DIRT: 4,
    WATER: 5
};

export class VoxelTypeManager {
    constructor() {
        this.types = new Map();
        this.setupDefaultTypes();
    }

    setupDefaultTypes() {
        // Air
        this.registerType(VoxelType.AIR, {
            name: "Air",
            transparent: true,
            solid: false,
            getColor: () => [0, 0, 0, 0]
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
            }
        });

        // Bedrock
        this.registerType(VoxelType.BEDROCK, {
            name: "Bedrock",
            transparent: false,
            solid: true,
            getColor: () => [0.2, 0.2, 0.2, 1.0]
        });

        // Stone
        this.registerType(VoxelType.STONE, {
            name: "Stone",
            transparent: false,
            solid: true,
            getColor: () => [0.5, 0.5, 0.5, 1.0]
        });

        // Dirt
        this.registerType(VoxelType.DIRT, {
            name: "Dirt",
            transparent: false,
            solid: true,
            getColor: () => [0.5, 0.3, 0.1, 1.0]
        });

        // Water
        this.registerType(VoxelType.WATER, {
            name: "Water",
            transparent: true,
            solid: true, // Semi-solid for physics
            getColor: () => [0.0, 0.3, 0.8, 0.7]
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
}