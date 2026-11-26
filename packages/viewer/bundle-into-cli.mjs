// Copy the built viewer into the CLI package so `git-cinematic view` can serve it.
import { cpSync, existsSync, rmSync } from "node:fs";

const target = new URL("../cli/dist/viewer/", import.meta.url);
if (existsSync(target)) rmSync(target, { recursive: true });
cpSync(new URL("./dist/", import.meta.url), target, { recursive: true });
