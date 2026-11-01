import { convertOfficeJob } from './pdf-convert-job.mjs';
import { errorMessageOf } from '../../../vendor/ieumoffice/apps/shell/src/main/pdf-structure/protocol.ts';
// Adapt Node's IPC to the unchanged utility-process entry and original Office converters.
process.parentPort = {
  once: (event, listener) => process.once(event, data => {
    if (data?.type !== 'run' || data.job?.op !== 'office') { listener({ data }); return; }
    const post = message => { if (process.connected) process.send(message); };
    void convertOfficeJob(data, (done, total) => post({ type: 'progress', done, total })).then(
      value => post({ type: 'result', value }), error => post(errorMessageOf(error)),
    );
  }),
  postMessage: message => { if (process.connected) process.send(message); },
};
process.once('disconnect', () => process.exit(0));
await import('../../../vendor/ieumoffice/apps/shell/src/main/pdf-structure/pdf-structure-process.ts');
