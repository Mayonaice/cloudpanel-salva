import type { Server } from "node:http";
export function createNasAgent(config: { root: string; token: string; origin: string; publicUrl: string }): Promise<Server>;
