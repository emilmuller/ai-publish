export type RepoFileSnippetRequest = {
	path: string
	startLine: number
	endLine: number
}

export type RepoFileSnippet = {
	path: string
	ref: string
	startLine: number
	endLine: number
	lines: string[]
	isTruncated: boolean
	byteLength: number
}

export type RepoFileSearchRequest = {
	path: string
	query: string
	ignoreCase?: boolean
	maxResults?: number
}

export type RepoFileSearchMatch = {
	lineNumber: number
	line: string
}

export type RepoFileSearchResult = {
	path: string
	ref: string
	query: string
	ignoreCase: boolean
	matches: RepoFileSearchMatch[]
	isTruncated: boolean
	byteLength: number
}

export type RepoTextSearchRequest = {
	query: string
	ignoreCase?: boolean
	// Optional prefix like "src/" to narrow scanning.
	pathPrefix?: string
	// Optional extensions like [".ts", ".md"].
	fileExtensions?: string[]
	maxResults?: number
	maxFiles?: number
}

export type RepoTextSearchMatch = {
	path: string
	lineNumber: number
	line: string
}

export type RepoTextSearchResult = {
	ref: string
	query: string
	ignoreCase: boolean
	pathPrefix?: string
	fileExtensions?: string[]
	matches: RepoTextSearchMatch[]
	filesScanned: number
	isTruncated: boolean
	byteLength: number
}

export type RepoFileListRequest = {
	// Optional prefix like "src/" to narrow listing.
	pathPrefix?: string
	// Optional extensions like [".ts", ".md"].
	fileExtensions?: string[]
	maxFiles?: number
}

export type RepoFileListResult = {
	ref: string
	pathPrefix?: string
	fileExtensions?: string[]
	paths: string[]
	isTruncated: boolean
	byteLength: number
}

export type RepoPathSearchRequest = {
	query: string
	ignoreCase?: boolean
	// Optional prefix like "src/" to narrow listing.
	pathPrefix?: string
	// Optional extensions like [".ts", ".md"].
	fileExtensions?: string[]
	maxFiles?: number
}

export type RepoPathSearchResult = {
	ref: string
	query: string
	ignoreCase: boolean
	pathPrefix?: string
	fileExtensions?: string[]
	paths: string[]
	isTruncated: boolean
	byteLength: number
}

export type RepoSnippetAroundRequest = {
	path: string
	lineNumber: number
	contextLines?: number
}

export type RepoSnippetAroundResult = {
	path: string
	ref: string
	requestedLine: number
	contextLines: number
	startLine: number
	endLine: number
	lines: string[]
	isTruncated: boolean
	byteLength: number
}

export type RepoFileMetaRequest = {
	path: string
}

export type RepoFileMetaResult = {
	path: string
	ref: string
	byteSize: number
	isBinary: boolean
	lineCount: number | null
	lineCountIsTruncated: boolean
	byteLength: number
}
