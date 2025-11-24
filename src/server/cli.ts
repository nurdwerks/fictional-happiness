#!/usr/bin/env node
import { CollaborationServer } from './server';

const port = process.argv[2] ? parseInt(process.argv[2]) : 3000;

try {
    const server = new CollaborationServer(undefined, port);
    console.log(`Server running on port ${port}`);
} catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
}
