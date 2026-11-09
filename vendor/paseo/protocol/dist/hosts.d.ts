import { z } from "zod";
export declare const HostMetadataSchema: z.ZodRecord<z.ZodString, z.ZodString>;
export declare const HostAddSchema: z.ZodObject<{
    connection: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    sourceKey: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const HostUpdateSchema: z.ZodObject<{
    label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    connection: z.ZodOptional<z.ZodString>;
    replaceIdentity: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const HostSummarySchema: z.ZodObject<{
    registrationId: z.ZodString;
    serverId: z.ZodNullable<z.ZodString>;
    label: z.ZodNullable<z.ZodString>;
    source: z.ZodObject<{
        id: z.ZodString;
        key: z.ZodString;
    }, z.core.$strip>;
    metadata: z.ZodRecord<z.ZodString, z.ZodString>;
    enabled: z.ZodBoolean;
    status: z.ZodEnum<{
        error: "error";
        connecting: "connecting";
        online: "online";
        offline: "offline";
        disabled: "disabled";
    }>;
    targetDescription: z.ZodString;
    lastOnlineAt: z.ZodNullable<z.ZodString>;
    nextRetryAt: z.ZodNullable<z.ZodString>;
    error: z.ZodNullable<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const HostDirectorySchema: z.ZodObject<{
    self: z.ZodObject<{
        serverId: z.ZodString;
        label: z.ZodString;
    }, z.core.$strip>;
    hosts: z.ZodArray<z.ZodObject<{
        registrationId: z.ZodString;
        serverId: z.ZodNullable<z.ZodString>;
        label: z.ZodNullable<z.ZodString>;
        source: z.ZodObject<{
            id: z.ZodString;
            key: z.ZodString;
        }, z.core.$strip>;
        metadata: z.ZodRecord<z.ZodString, z.ZodString>;
        enabled: z.ZodBoolean;
        status: z.ZodEnum<{
            error: "error";
            connecting: "connecting";
            online: "online";
            offline: "offline";
            disabled: "disabled";
        }>;
        targetDescription: z.ZodString;
        lastOnlineAt: z.ZodNullable<z.ZodString>;
        nextRetryAt: z.ZodNullable<z.ZodString>;
        error: z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            message: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type HostAdd = z.infer<typeof HostAddSchema>;
export type HostUpdate = z.infer<typeof HostUpdateSchema>;
export type HostSummary = z.infer<typeof HostSummarySchema>;
export type HostDirectory = z.infer<typeof HostDirectorySchema>;
export declare const HostsListRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.list.request">;
    requestId: z.ZodString;
    observe: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const HostsAddRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.add.request">;
    requestId: z.ZodString;
    input: z.ZodObject<{
        connection: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        sourceKey: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsUpdateRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.update.request">;
    requestId: z.ZodString;
    registrationId: z.ZodString;
    patch: z.ZodObject<{
        label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        connection: z.ZodOptional<z.ZodString>;
        replaceIdentity: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsRemoveRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.remove.request">;
    requestId: z.ZodString;
    registrationId: z.ZodString;
}, z.core.$strip>;
export declare const HostsRouteOpenRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.route.open.request">;
    requestId: z.ZodString;
    serverId: z.ZodString;
    scopeId: z.ZodString;
}, z.core.$strip>;
export declare const HostsRouteFrameRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.route.frame.request">;
    routeId: z.ZodString;
    data: z.ZodString;
    binary: z.ZodLiteral<false>;
}, z.core.$strip>;
export declare const HostsRouteCloseRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.route.close.request">;
    routeId: z.ZodOptional<z.ZodString>;
    scopeId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const HostsListResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.list.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        directory: z.ZodObject<{
            self: z.ZodObject<{
                serverId: z.ZodString;
                label: z.ZodString;
            }, z.core.$strip>;
            hosts: z.ZodArray<z.ZodObject<{
                registrationId: z.ZodString;
                serverId: z.ZodNullable<z.ZodString>;
                label: z.ZodNullable<z.ZodString>;
                source: z.ZodObject<{
                    id: z.ZodString;
                    key: z.ZodString;
                }, z.core.$strip>;
                metadata: z.ZodRecord<z.ZodString, z.ZodString>;
                enabled: z.ZodBoolean;
                status: z.ZodEnum<{
                    error: "error";
                    connecting: "connecting";
                    online: "online";
                    offline: "offline";
                    disabled: "disabled";
                }>;
                targetDescription: z.ZodString;
                lastOnlineAt: z.ZodNullable<z.ZodString>;
                nextRetryAt: z.ZodNullable<z.ZodString>;
                error: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    message: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        subscriptionId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.changed">;
    payload: z.ZodObject<{
        subscriptionId: z.ZodString;
        directory: z.ZodObject<{
            self: z.ZodObject<{
                serverId: z.ZodString;
                label: z.ZodString;
            }, z.core.$strip>;
            hosts: z.ZodArray<z.ZodObject<{
                registrationId: z.ZodString;
                serverId: z.ZodNullable<z.ZodString>;
                label: z.ZodNullable<z.ZodString>;
                source: z.ZodObject<{
                    id: z.ZodString;
                    key: z.ZodString;
                }, z.core.$strip>;
                metadata: z.ZodRecord<z.ZodString, z.ZodString>;
                enabled: z.ZodBoolean;
                status: z.ZodEnum<{
                    error: "error";
                    connecting: "connecting";
                    online: "online";
                    offline: "offline";
                    disabled: "disabled";
                }>;
                targetDescription: z.ZodString;
                lastOnlineAt: z.ZodNullable<z.ZodString>;
                nextRetryAt: z.ZodNullable<z.ZodString>;
                error: z.ZodNullable<z.ZodObject<{
                    code: z.ZodString;
                    message: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsAddResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.add.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        host: z.ZodObject<{
            registrationId: z.ZodString;
            serverId: z.ZodNullable<z.ZodString>;
            label: z.ZodNullable<z.ZodString>;
            source: z.ZodObject<{
                id: z.ZodString;
                key: z.ZodString;
            }, z.core.$strip>;
            metadata: z.ZodRecord<z.ZodString, z.ZodString>;
            enabled: z.ZodBoolean;
            status: z.ZodEnum<{
                error: "error";
                connecting: "connecting";
                online: "online";
                offline: "offline";
                disabled: "disabled";
            }>;
            targetDescription: z.ZodString;
            lastOnlineAt: z.ZodNullable<z.ZodString>;
            nextRetryAt: z.ZodNullable<z.ZodString>;
            error: z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                message: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsUpdateResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.update.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        host: z.ZodObject<{
            registrationId: z.ZodString;
            serverId: z.ZodNullable<z.ZodString>;
            label: z.ZodNullable<z.ZodString>;
            source: z.ZodObject<{
                id: z.ZodString;
                key: z.ZodString;
            }, z.core.$strip>;
            metadata: z.ZodRecord<z.ZodString, z.ZodString>;
            enabled: z.ZodBoolean;
            status: z.ZodEnum<{
                error: "error";
                connecting: "connecting";
                online: "online";
                offline: "offline";
                disabled: "disabled";
            }>;
            targetDescription: z.ZodString;
            lastOnlineAt: z.ZodNullable<z.ZodString>;
            nextRetryAt: z.ZodNullable<z.ZodString>;
            error: z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                message: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsRemoveResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.remove.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsRouteOpenResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.route.open.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        routeId: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsRouteFrameSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.route.frame">;
    payload: z.ZodObject<{
        subscriptionId: z.ZodString;
        data: z.ZodString;
        binary: z.ZodLiteral<false>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsRouteClosedSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.route.closed">;
    payload: z.ZodObject<{
        subscriptionId: z.ZodString;
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsLinkOpenRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.link.open.request">;
    requestId: z.ZodString;
    channelId: z.ZodString;
    flowControl: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const HostsLinkOpenResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.link.open.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        routeId: z.ZodString;
        flowControl: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const HostsLinkAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"hosts.link.ack.request">;
    routeId: z.ZodString;
    sequence: z.ZodNumber;
}, z.core.$strip>;
