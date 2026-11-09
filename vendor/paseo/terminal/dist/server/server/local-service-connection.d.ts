import http from "node:http";
import net from "node:net";
export declare function connectToLocalService(port: number): net.Socket;
export declare function requestLocalService(options: Pick<http.RequestOptions, "port" | "path" | "method" | "headers">, onResponse: (response: http.IncomingMessage) => void): http.ClientRequest;
