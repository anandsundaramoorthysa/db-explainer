import { parentPort, workerData } from 'worker_threads';
import { handle, SqliteRequest } from './sqliteCore';

void handle(workerData as SqliteRequest).then((reply) => parentPort?.postMessage(reply));
