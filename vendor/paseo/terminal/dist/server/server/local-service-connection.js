import http from "node:http";
import net from "node:net";
// A host can support IPv6 loopback without listing ::1 for localhost in DNS.
const lookupLoopback = (_hostname, _options, callback) => {
    callback(null, [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
    ]);
};
export function connectToLocalService(port) {
    return net.connect({ host: "localhost", port, autoSelectFamily: true, lookup: lookupLoopback });
}
export function requestLocalService(options, onResponse) {
    const requestOptions = {
        ...options,
        hostname: "localhost",
        autoSelectFamily: true,
        lookup: lookupLoopback,
    };
    return http.request(requestOptions, onResponse);
}
