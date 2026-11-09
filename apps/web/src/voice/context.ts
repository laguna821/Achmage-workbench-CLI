import { createContext } from "react";
import type { Api } from "../api.ts";
export const VoiceEnvironment = createContext<Api | null>(null);
