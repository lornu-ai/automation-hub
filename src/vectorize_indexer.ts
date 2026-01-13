// vectorize_indexer.ts
// Issue #565: Private RAG Grounding via Cloudflare R2 + Vectorize
//
// This module handles the R2 -> Vectorize indexing pipeline:
// 1. Reads documents from the private R2 bucket
// 2. Chunks documents into 1000 token chunks with 100 token overlap
// 3. Generates embeddings using Cloudflare AI (bge-base-en-v1.5)
// 4. Upserts vectors to the Vectorize index

// Use the shared Env interface from worker.ts
export interface VectorizeEnv {
  PRIVATE_RAG_BUCKET: R2Bucket;
  LORNU_VECTORIZE: VectorizeIndex;
  AI: Ai;
}

// Alias for backwards compatibility - functions accept any object with required bindings
type Env = VectorizeEnv;

export interface IndexResult {
  success: boolean;
  documentsProcessed: number;
  chunksIndexed: number;
  errors: string[];
}

export interface DocumentChunk {
	id: string;
	content: string;
	metadata: {
		source: string;
		chunkIndex: number;
		totalChunks: number;
		createdAt: string;
		content: string;
	};
}

// Configuration constants
const CHUNK_SIZE = 1000; // tokens (approximate by characters / 4)
const CHUNK_OVERLAP = 100; // tokens overlap between chunks
const CHARS_PER_TOKEN = 4; // rough approximation

/**
 * Splits text into overlapping chunks for embedding
 */
function chunkText(text: string, source: string): DocumentChunk[] {
	const chunks: DocumentChunk[] = [];
	const chunkSizeChars = CHUNK_SIZE * CHARS_PER_TOKEN;
	const overlapChars = CHUNK_OVERLAP * CHARS_PER_TOKEN;
	const stepSize = chunkSizeChars - overlapChars;

	let position = 0;
	let chunkIndex = 0;

	while (position < text.length) {
		const end = Math.min(position + chunkSizeChars, text.length);
		const content = text.slice(position, end);

		// Skip empty chunks
		if (content.trim().length > 0) {
			const trimmedContent = content.trim();
			chunks.push({
				id: `${source}-chunk-${chunkIndex}`,
				content: trimmedContent,
				metadata: {
					source,
					chunkIndex,
					totalChunks: -1, // Will be updated after all chunks are created
					createdAt: new Date().toISOString(),
					content: trimmedContent,
				},
			});
			chunkIndex++;
		}

		if (end === text.length) break;
		position += stepSize;
	}

	// Update totalChunks in metadata
	chunks.forEach(chunk => {
		chunk.metadata.totalChunks = chunks.length;
	});

	return chunks;
}

/**
 * Lists all documents in the R2 bucket
 */
async function listDocuments(bucket: R2Bucket): Promise<R2Object[]> {
  const documents: R2Object[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    documents.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return documents;
}

/**
 * Reads document content from R2
 */
async function readDocument(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  // Support text-based formats
  const textExtensions = ['.txt', '.md', '.json', '.yaml', '.yml', '.html', '.csv'];
  const isTextFile = textExtensions.some(ext => key.toLowerCase().endsWith(ext));

  if (!isTextFile) {
    console.log(`Skipping non-text file: ${key}`);
    return null;
  }

  return await object.text();
}

/**
 * Generates embeddings for text chunks using Cloudflare AI
 */
async function generateEmbeddings(
  ai: Ai,
  chunks: DocumentChunk[]
): Promise<{ chunk: DocumentChunk; embedding: number[] }[]> {
  const results: { chunk: DocumentChunk; embedding: number[] }[] = [];

  // Process in batches to avoid rate limits
  const batchSize = 10;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map(c => c.content);

    // Use bge-base-en-v1.5 for embeddings (confirmed design decision)
    const embeddings = await ai.run('@cf/baai/bge-base-en-v1.5', {
      text: texts,
    }) as { data: number[][] };

    for (let j = 0; j < batch.length; j++) {
      results.push({
        chunk: batch[j],
        embedding: embeddings.data[j],
      });
    }
  }

  return results;
}

/**
 * Upserts vectors to the Vectorize index
 */
async function upsertVectors(
  vectorize: VectorizeIndex,
  embeddings: { chunk: DocumentChunk; embedding: number[] }[]
): Promise<void> {
  const vectors = embeddings.map(({ chunk, embedding }) => ({
    id: chunk.id,
    values: embedding,
    metadata: chunk.metadata,
  }));

  // Upsert in batches of 100
  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize);
    await vectorize.upsert(batch);
  }
}

/**
 * Main indexing function - processes all documents in R2 bucket
 */
export async function indexAllDocuments(env: Env): Promise<IndexResult> {
  const result: IndexResult = {
    success: true,
    documentsProcessed: 0,
    chunksIndexed: 0,
    errors: [],
  };

  try {
    // List all documents
    const documents = await listDocuments(env.PRIVATE_RAG_BUCKET);
    console.log(`Found ${documents.length} documents in R2 bucket`);

    for (const doc of documents) {
      try {
        // Read document content
        const content = await readDocument(env.PRIVATE_RAG_BUCKET, doc.key);
        if (!content) continue;

        // Chunk the document
        const chunks = chunkText(content, doc.key);
        console.log(`Document ${doc.key}: ${chunks.length} chunks`);

        // Generate embeddings
        const embeddings = await generateEmbeddings(env.AI, chunks);

        // Upsert to Vectorize
        await upsertVectors(env.LORNU_VECTORIZE, embeddings);

        result.documentsProcessed++;
        result.chunksIndexed += chunks.length;
      } catch (docError) {
        const errorMsg = `Error processing ${doc.key}: ${docError}`;
        console.error(errorMsg);
        result.errors.push(errorMsg);
      }
    }
  } catch (error) {
    result.success = false;
    result.errors.push(`Fatal error: ${error}`);
  }

  return result;
}

/**
 * Indexes a single document (for incremental updates)
 */
export async function indexDocument(
  env: Env,
  key: string
): Promise<{ success: boolean; chunksIndexed: number; error?: string }> {
  try {
    const content = await readDocument(env.PRIVATE_RAG_BUCKET, key);
    if (!content) {
      return { success: false, chunksIndexed: 0, error: 'Document not found or not a text file' };
    }

    const chunks = chunkText(content, key);
    const embeddings = await generateEmbeddings(env.AI, chunks);
    await upsertVectors(env.LORNU_VECTORIZE, embeddings);

    return { success: true, chunksIndexed: chunks.length };
  } catch (error) {
    return { success: false, chunksIndexed: 0, error: String(error) };
  }
}

/**
 * Searches the Vectorize index and returns enriched content
 */
export async function searchVectorize(
	env: Env,
	query: string,
	topK: number = 5,
	filterMetadata?: Record<string, string>
): Promise<{ id: string; score: number; source: string; content: string }[]> {
	// Generate embedding for query
	const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
		text: [query],
	}) as { data: number[][] };

	// Search Vectorize
	const results = await env.LORNU_VECTORIZE.query(queryEmbedding.data[0], {
		topK,
		returnMetadata: true, // Request full metadata
	});

	return results.matches.map(match => ({
		id: match.id,
		score: match.score,
		source: (match.metadata?.source as string) || 'unknown',
		content: (match.metadata?.content as string) || '',
	}));
}


/**
 * Gets the current status of the Vectorize index
 */
export async function getIndexStatus(env: Env): Promise<{
  documentCount: number;
  lastUpdated: string | null;
  healthy: boolean;
}> {
  try {
    // List documents to get count and last update
    const documents = await listDocuments(env.PRIVATE_RAG_BUCKET);

    let lastUpdated: string | null = null;
    if (documents.length > 0) {
      // Find the most recently uploaded document
      const sorted = documents.sort((a, b) =>
        new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime()
      );
      lastUpdated = sorted[0].uploaded.toISOString();
    }

    return {
      documentCount: documents.length,
      lastUpdated,
      healthy: true,
    };
  } catch (error) {
    console.error("Error getting index status:", error);
    return {
      documentCount: 0,
      lastUpdated: null,
      healthy: false,
    };
  }
}
