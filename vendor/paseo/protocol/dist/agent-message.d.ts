import { z } from "zod";
/** Semantic provenance, independent of provider envelopes and timeline presentation. */
export declare const AgentMessageSchema: z.ZodObject<{
    event: z.ZodEnum<{
        message: "message";
        finished: "finished";
        errored: "errored";
        "permission-required": "permission-required";
        closed: "closed";
    }>;
    sender: z.ZodObject<{
        id: z.ZodString;
        serverId: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    text: z.ZodString;
}, z.core.$strip>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
