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
            transparent: true, // Only air is transparent
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

        // Water - now fully opaque
        this.registerType(VoxelType.WATER, {
            name: "Water",
            transparent: false, // Changed from true to false
            solid: true,
            getColor: () => [0.0, 0.3, 0.8, 1.0] // Changed alpha from 0.7 to 1.0
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

    // Get serializable data for workers
    getSerializableData() {
        const data = {};
        for (const [id, type] of this.types.entries()) {
            data[id] = {
                transparent: type.transparent,
                solid: type.solid
            };
        }
        return data;
    }
}