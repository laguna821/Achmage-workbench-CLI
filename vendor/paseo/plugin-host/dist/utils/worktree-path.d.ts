/**
 * Validate a worktree destination. Throws
 * with the reason on any violation; returns the normalized absolute path.
 */
export declare function validateWorktreePath(options: {
    candidate: string;
    repoPath: string;
}): Promise<string>;
