import { openai } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { db } from "./db";
import { headlines, manualSubmissions, headlineClusters } from "@shared/schema";
import { eq, sql, and, or, isNull, gte, desc, inArray } from "drizzle-orm";


interface HeadlineItem {
  id: string;
  title: string;
  source: string;
  priority: number;
  type: 'headline' | 'manual';
  clusterId: string | null;
  isClusterRepresentative: boolean | null;
}

interface ClusterResult {
  clusterName: string;
  headlineIds: string[];
}

export async function clusterTopStories(resetExisting: boolean = false): Promise<void> {
  console.log('[Clustering] Starting headline clustering for Top Stories...');
  
  // Use 12 hours for clustering window, look at ALL stories regardless of priority
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);

  if (resetExisting) {
    console.log('[Clustering] Resetting existing cluster assignments...');
    await db
      .update(headlines)
      .set({ clusterId: null, isClusterRepresentative: false })
      .where(gte(headlines.scrapedAt, twelveHoursAgo));
    await db
      .update(manualSubmissions)
      .set({ clusterId: null, isClusterRepresentative: false })
      .where(gte(manualSubmissions.submittedAt, twelveHoursAgo));
    
    // Clean up orphaned AI-created clusters (preserve user-created clusters as seeds)
    console.log('[Clustering] Cleaning up orphaned AI-created clusters...');
    const orphanedClusters = await db.execute(sql`
      DELETE FROM headline_clusters 
      WHERE is_user_created = false
      AND id NOT IN (
        SELECT DISTINCT cluster_id FROM headlines WHERE cluster_id IS NOT NULL
        UNION
        SELECT DISTINCT cluster_id FROM manual_submissions WHERE cluster_id IS NOT NULL
      )
      RETURNING id
    `);
    console.log(`[Clustering] Deleted ${orphanedClusters.rowCount || 0} orphaned AI-created clusters (user-created preserved)`);
  }

  // Get ALL headlines from past 12 hours regardless of priority score
  const topHeadlines = await db
    .select({
      id: headlines.id,
      title: headlines.title,
      source: headlines.source,
      priority: sql<number>`COALESCE(${headlines.priorityOverride}, ${headlines.priorityScore})`,
      clusterId: headlines.clusterId,
      isClusterRepresentative: headlines.isClusterRepresentative,
    })
    .from(headlines)
    // Exclude MCOP-restricted rows from clustering so a Warfighter-only
    // headline can never become the representative of a global cluster
    // (which would hide global stories from the main feed) and vice versa.
    .where(and(
      gte(headlines.scrapedAt, twelveHoursAgo),
      sql`${headlines.restrictedToMcops} IS NULL`,
    ))
    .orderBy(desc(sql`COALESCE(${headlines.priorityOverride}, ${headlines.priorityScore})`));

  const topManualSubmissions = await db
    .select({
      id: manualSubmissions.id,
      title: manualSubmissions.title,
      source: manualSubmissions.source,
      priority: sql<number>`COALESCE(${manualSubmissions.priorityOverride}, ${manualSubmissions.priorityScore})`,
      clusterId: manualSubmissions.clusterId,
      isClusterRepresentative: manualSubmissions.isClusterRepresentative,
    })
    .from(manualSubmissions)
    .where(gte(manualSubmissions.submittedAt, twelveHoursAgo))
    .orderBy(desc(sql`COALESCE(${manualSubmissions.priorityOverride}, ${manualSubmissions.priorityScore})`));

  const allItems: HeadlineItem[] = [
    ...topHeadlines.map(h => ({ ...h, type: 'headline' as const })),
    ...topManualSubmissions.map(m => ({ ...m, type: 'manual' as const })),
  ];

  const unclusteredItems = allItems.filter(item => !item.clusterId);
  const clusteredItems = allItems.filter(item => item.clusterId);
  
  // Get existing cluster representatives to include in analysis
  // This allows new items to be grouped with existing events
  const existingClusterReps = clusteredItems.filter(item => item.isClusterRepresentative);

  // Build a map of existing cluster representatives by cluster ID
  const clusterRepMap = new Map<string, HeadlineItem>();
  for (const rep of existingClusterReps) {
    if (rep.clusterId) {
      clusterRepMap.set(rep.clusterId, rep);
    }
  }

  // For incremental clustering, include existing reps + unclustered items
  const itemsToCluster = resetExisting 
    ? allItems 
    : [...unclusteredItems, ...existingClusterReps];
  
  if (itemsToCluster.length < 2) {
    console.log('[Clustering] Not enough items to cluster');
    // Still clean up empty clusters even if no new clustering is needed
    await cleanupEmptyClusters();
    return;
  }

  console.log(`[Clustering] Analyzing ${itemsToCluster.length} items (${unclusteredItems.length} unclustered, ${existingClusterReps.length} existing reps)`);

  // Fetch all user-created clusters to use as seed topics for AI
  const userCreatedClusters = await db
    .select({ id: headlineClusters.id, name: headlineClusters.name })
    .from(headlineClusters)
    .where(eq(headlineClusters.isUserCreated, true));
  
  const userClusterNames = userCreatedClusters.map(c => c.name);
  const userClusterByName = new Map(userCreatedClusters.map(c => [c.name.toLowerCase(), c.id]));
  
  console.log(`[Clustering] Found ${userClusterNames.length} user-created cluster topics`);

  const clusters = await identifyClusters(itemsToCluster, userClusterNames);
  
  if (clusters.length === 0) {
    console.log('[Clustering] No clusters identified');
    // Still clean up empty clusters even if no new clusters were identified
    await cleanupEmptyClusters();
    return;
  }

  for (const cluster of clusters) {
    if (cluster.headlineIds.length < 2) continue;
    
    const itemsInCluster = itemsToCluster.filter(item => 
      cluster.headlineIds.includes(item.id)
    );
    
    // Find all existing cluster reps in this cluster
    const existingRepsInCluster = itemsInCluster.filter(item => 
      item.clusterId && clusterRepMap.has(item.clusterId)
    );
    
    // Get unique cluster IDs represented
    const uniqueClusterIds = new Set(existingRepsInCluster.map(r => r.clusterId).filter(Boolean));
    
    // Skip if multiple existing clusters would be merged (safeguard against collapsing distinct clusters)
    if (uniqueClusterIds.size > 1) {
      console.log(`[Clustering] Skipping cluster "${cluster.clusterName}" - would merge ${uniqueClusterIds.size} existing clusters`);
      continue;
    }
    
    let targetClusterId: string;
    
    // Check if AI returned a user-created cluster name
    const matchingUserClusterId = userClusterByName.get(cluster.clusterName.toLowerCase());
    
    if (existingRepsInCluster.length > 0 && existingRepsInCluster[0].clusterId) {
      // Merge into existing cluster (from items already clustered)
      targetClusterId = existingRepsInCluster[0].clusterId;
      console.log(`[Clustering] Merging ${itemsInCluster.length} items into existing cluster ${targetClusterId}`);
      
      // Clear isClusterRepresentative for all items in target cluster first
      await db
        .update(headlines)
        .set({ isClusterRepresentative: false })
        .where(eq(headlines.clusterId, targetClusterId));
      await db
        .update(manualSubmissions)
        .set({ isClusterRepresentative: false })
        .where(eq(manualSubmissions.clusterId, targetClusterId));
    } else if (matchingUserClusterId) {
      // Use existing user-created cluster
      targetClusterId = matchingUserClusterId;
      console.log(`[Clustering] Using user-created cluster "${cluster.clusterName}" (${targetClusterId})`);
      
      // Clear isClusterRepresentative for existing items in this cluster
      await db
        .update(headlines)
        .set({ isClusterRepresentative: false })
        .where(eq(headlines.clusterId, targetClusterId));
      await db
        .update(manualSubmissions)
        .set({ isClusterRepresentative: false })
        .where(eq(manualSubmissions.clusterId, targetClusterId));
    } else {
      // Create new cluster
      const [newCluster] = await db
        .insert(headlineClusters)
        .values({ name: cluster.clusterName })
        .returning();
      targetClusterId = newCluster.id;
      console.log(`[Clustering] Created new cluster "${cluster.clusterName}"`);
    }
    
    // Determine highest priority item as representative
    const sortedItems = itemsInCluster.sort((a, b) => b.priority - a.priority);
    const representativeId = sortedItems[0].id;
    const representativeType = sortedItems[0].type;

    // Update all items in the cluster
    for (const item of itemsInCluster) {
      const isRep = item.id === representativeId;
      
      if (item.type === 'headline') {
        await db
          .update(headlines)
          .set({ 
            clusterId: targetClusterId, 
            isClusterRepresentative: isRep 
          })
          .where(eq(headlines.id, item.id));
      } else {
        await db
          .update(manualSubmissions)
          .set({ 
            clusterId: targetClusterId, 
            isClusterRepresentative: isRep 
          })
          .where(eq(manualSubmissions.id, item.id));
      }
    }

    console.log(`[Clustering] Cluster has ${cluster.headlineIds.length} items, representative: ${representativeId}`);
  }

  // Clean up any clusters that became empty (headlines aged out)
  await cleanupEmptyClusters();

  console.log('[Clustering] Clustering complete');
}

async function identifyClusters(items: HeadlineItem[], userClusterNames: string[] = []): Promise<ClusterResult[]> {
  if (items.length < 2) return [];

  const headlineList = items.map((item, idx) => 
    `${idx + 1}. [${item.id}] "${item.title}" (${item.source})`
  ).join('\n');

  const userClustersSection = userClusterNames.length > 0 
    ? `\n\nEXISTING TOPIC CLUSTERS (prefer matching to these when applicable):
${userClusterNames.map((name, idx) => `- "${name}"`).join('\n')}

If headlines match any of these existing topics, use the EXACT cluster name from the list above.`
    : '';

  const prompt = `Analyze these news headlines and identify groups that cover THE SAME news event or story. Only group headlines that are about the exact same event, not just the same general topic.

Headlines:
${headlineList}${userClustersSection}

Return a JSON object with a "clusters" key containing an array of clusters. Each cluster should have:
- clusterName: A brief descriptive name for the news event (max 50 chars)
- headlineIds: Array of headline IDs that cover this same event

Only include clusters with 2 or more headlines. If a headline is unique and doesn't match others, don't include it.

Example response:
{"clusters": [
  {"clusterName": "Ukraine Peace Talks in Abu Dhabi", "headlineIds": ["abc123", "def456", "ghi789"]},
  {"clusterName": "Cuba Naval Blockade Consideration", "headlineIds": ["jkl012", "mno345"]}
]}`;

  let content: string | undefined;
  try {
    const response = await withAiTimeout(openai.chat.completions.create({
      model: "gpt-4o-mini-pinned",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'identifyClusters');

    content = response.choices[0]?.message?.content?.trim();
    if (!content) return [];
  } catch (error) {
    console.error('[Clustering] AI call failed for identifyClusters:', error);
    return [];
  }

  let clusters: ClusterResult[];
  try {
    const parsed = JSON.parse(content);
    clusters = (parsed.clusters ?? parsed) as ClusterResult[];
    if (!Array.isArray(clusters)) return [];
  } catch (parseError) {
    console.error('[Clustering] Malformed AI response - JSON parse failed. Raw:', content?.slice(0, 300), parseError);
    return [];
  }

  const validIds = new Set(items.map(i => i.id));
  return clusters
    .filter(c => c.headlineIds && c.headlineIds.length >= 2)
    .map(c => ({
      ...c,
      headlineIds: c.headlineIds.filter(id => validIds.has(id))
    }))
    .filter(c => c.headlineIds.length >= 2);
}

export async function setClusterRepresentative(
  clusterId: string, 
  newRepresentativeId: string,
  itemType: 'headline' | 'manual'
): Promise<void> {
  await db
    .update(headlines)
    .set({ isClusterRepresentative: false })
    .where(eq(headlines.clusterId, clusterId));
  
  await db
    .update(manualSubmissions)
    .set({ isClusterRepresentative: false })
    .where(eq(manualSubmissions.clusterId, clusterId));

  if (itemType === 'headline') {
    await db
      .update(headlines)
      .set({ isClusterRepresentative: true })
      .where(eq(headlines.id, newRepresentativeId));
  } else {
    await db
      .update(manualSubmissions)
      .set({ isClusterRepresentative: true })
      .where(eq(manualSubmissions.id, newRepresentativeId));
  }
}

export async function unlinkFromCluster(
  itemId: string,
  itemType: 'headline' | 'manual'
): Promise<void> {
  if (itemType === 'headline') {
    await db
      .update(headlines)
      .set({ clusterId: null, isClusterRepresentative: true })
      .where(eq(headlines.id, itemId));
  } else {
    await db
      .update(manualSubmissions)
      .set({ clusterId: null, isClusterRepresentative: true })
      .where(eq(manualSubmissions.id, itemId));
  }
}

export async function mergeClusters(
  sourceClusterId: string,
  targetClusterId: string
): Promise<void> {
  await db
    .update(headlines)
    .set({ clusterId: targetClusterId, isClusterRepresentative: false })
    .where(eq(headlines.clusterId, sourceClusterId));
  
  await db
    .update(manualSubmissions)
    .set({ clusterId: targetClusterId, isClusterRepresentative: false })
    .where(eq(manualSubmissions.clusterId, sourceClusterId));

  await db
    .delete(headlineClusters)
    .where(eq(headlineClusters.id, sourceClusterId));
}

export async function getClusterDetails(clusterId: string) {
  const cluster = await db
    .select()
    .from(headlineClusters)
    .where(eq(headlineClusters.id, clusterId))
    .limit(1);

  if (cluster.length === 0) return null;

  const clusterHeadlines = await db
    .select()
    .from(headlines)
    .where(eq(headlines.clusterId, clusterId));

  const clusterManualSubmissions = await db
    .select()
    .from(manualSubmissions)
    .where(eq(manualSubmissions.clusterId, clusterId));

  return {
    ...cluster[0],
    headlines: clusterHeadlines,
    manualSubmissions: clusterManualSubmissions,
  };
}

export async function getAllClustersWithMembers() {
  // Filter to only include clusters with activity in the past 12 hours
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
  
  // Get cluster IDs that have recent headlines OR recent manual submissions
  const recentClusterIds = await db.execute<{ cluster_id: string }>(sql`
    SELECT DISTINCT cluster_id FROM (
      SELECT cluster_id FROM headlines 
      WHERE cluster_id IS NOT NULL AND scraped_at >= ${twelveHoursAgo}
      UNION
      SELECT cluster_id FROM manual_submissions 
      WHERE cluster_id IS NOT NULL AND submitted_at >= ${twelveHoursAgo}
    ) AS recent_clusters
  `);
  
  const activeClusterIds = recentClusterIds.rows.map(row => row.cluster_id);
  
  if (activeClusterIds.length === 0) {
    return [];
  }
  
  // Get only the clusters with recent activity
  const clusters = await db
    .select()
    .from(headlineClusters)
    .where(inArray(headlineClusters.id, activeClusterIds));
  
  const result = [];
  for (const cluster of clusters) {
    const clusterHeadlines = await db
      .select({
        id: headlines.id,
        title: headlines.title,
        source: headlines.source,
        url: headlines.url,
        priority: sql<number>`COALESCE(${headlines.priorityOverride}, ${headlines.priorityScore})`,
        isRepresentative: headlines.isClusterRepresentative,
        type: sql<string>`'headline'`,
      })
      .from(headlines)
      .where(eq(headlines.clusterId, cluster.id));

    const clusterManual = await db
      .select({
        id: manualSubmissions.id,
        title: manualSubmissions.title,
        source: manualSubmissions.source,
        url: manualSubmissions.url,
        priority: sql<number>`COALESCE(${manualSubmissions.priorityOverride}, ${manualSubmissions.priorityScore})`,
        isRepresentative: manualSubmissions.isClusterRepresentative,
        type: sql<string>`'manual'`,
      })
      .from(manualSubmissions)
      .where(eq(manualSubmissions.clusterId, cluster.id));

    const members = [...clusterHeadlines, ...clusterManual];
    
    if (members.length > 0) {
      result.push({
        ...cluster,
        members: members.sort((a, b) => {
          if (a.isRepresentative && !b.isRepresentative) return -1;
          if (!a.isRepresentative && b.isRepresentative) return 1;
          return b.priority - a.priority;
        }),
      });
    }
  }

  return result;
}

export async function cleanupEmptyClusters(): Promise<number> {
  console.log('[Clustering] Cleaning up empty clusters...');
  
  const orphanedClusters = await db.execute(sql`
    DELETE FROM headline_clusters 
    WHERE id NOT IN (
      SELECT DISTINCT cluster_id FROM headlines WHERE cluster_id IS NOT NULL
      UNION
      SELECT DISTINCT cluster_id FROM manual_submissions WHERE cluster_id IS NOT NULL
    )
    RETURNING id
  `);
  
  const deletedCount = orphanedClusters.rowCount || 0;
  if (deletedCount > 0) {
    console.log(`[Clustering] Deleted ${deletedCount} empty clusters`);
  }
  
  return deletedCount;
}
