// Adapt Node's child-process IPC to the original, unchanged utility-process entry.
process.parentPort = {
  once: (event, listener) => process.once(event, data => listener({ data })),
  postMessage: message => { if (process.connected) process.send(message); },
};
process.once('disconnect', () => process.exit(0));
await import('../../../vendor/ieumoffice/apps/shell/src/main/pdf-structure/pdf-structure-process.ts');
