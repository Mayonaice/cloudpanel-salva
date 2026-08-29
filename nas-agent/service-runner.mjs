import fs from "node:fs/promises";
import { createNasAgent } from "./server.mjs";

const configPath = process.argv[2];
if (!configPath) throw new Error("Pass the private JSON configuration path");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const server = await createNasAgent(config);
const port = Number(config.port ?? 8787);
server.listen(port, "127.0.0.1", () => console.log(`Salva NAS Agent listening on 127.0.0.1:${port}`));
