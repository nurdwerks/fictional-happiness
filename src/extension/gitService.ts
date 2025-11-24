import * as vscode from 'vscode';
import * as cp from 'child_process';
import ignore, { Ignore } from 'ignore';
import * as fs from 'fs';
import * as path from 'path';

export class GitService {
    private ig: Ignore | undefined;

    constructor(private workspaceRoot: string | undefined) {
        this.loadGitignore();
        this.watchGitignore();
    }

    public async getUserName(): Promise<string | undefined> {
        return new Promise((resolve) => {
            cp.exec('git config user.name', (err, stdout) => {
                if (err || !stdout.trim()) {
                    resolve(undefined);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    private loadGitignore() {
        if (!this.workspaceRoot) {return;}

        const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, 'utf8');
                this.ig = ignore().add(content);
            } catch (e) {
                console.error("Failed to load .gitignore", e);
                this.ig = undefined;
            }
        } else {
            this.ig = undefined;
        }
    }

    private watchGitignore() {
        if (!this.workspaceRoot) {return;}

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, '.gitignore')
        );

        watcher.onDidChange(() => this.loadGitignore());
        watcher.onDidCreate(() => this.loadGitignore());
        watcher.onDidDelete(() => this.loadGitignore());
    }

    public isIgnored(filePath: string): boolean {
        if (!this.ig || !this.workspaceRoot) {return false;}

        // Get relative path
        const relative = path.relative(this.workspaceRoot, filePath);
        if (relative.startsWith('..')) {return false;} // Outside workspace

        return this.ig.ignores(relative);
    }
}
