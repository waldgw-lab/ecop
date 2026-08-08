import { openai } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { db } from "./db";
import { teamSubmissions, teamSubmissionClusters, teamSubjects } from "@shared/schema";
import { eq, sql, and, isNull, gte } from "drizzle-orm";


interface SubmissionItem {
  id: string;
  headline: string;
  sourceName: string | null;
  priority: number | null;
  clusterId: string | null;
  isClusterRepresentative: boolean;
}

interface ClusterResult {
  clusterName: string;
  submissionIds: string[];
}

export async function clusterSubmissionsForTopic(subjectId: string): Promise<void> {
  console.log(`[TeamClustering] Starting clustering for topic ${subjectId}...`);
  
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);

  const submissions = await db
    .select({
      id: teamSubmissions.id,
      headline: teamSubmissions.headline,
      sourceName: teamSubmissions.sourceName,
      priority: teamSubmissions.priorityScore,
      clusterId: teamSubmissions.clusterId,
      isClusterRepresentative: teamSubmissions.isClusterRepresentative,
    })
    .from(teamSubmissions)
    .where(
      and(
        eq(teamSubmissions.subjectId, subjectId),
        isNull(teamSubmissions.deletedAt),
        gte(teamSubmissions.createdAt, twelveHoursAgo)
      )
    );

  if (submissions.length < 2) {
    console.log('[TeamClustering] Not enough submissions to cluster');
    await cleanupEmptyTeamClusters(subjectId);
    return;
  }

  const unclusteredItems = submissions.filter(s => !s.clusterId);
  const existingClusterReps = submissions.filter(s => s.isClusterRepresentative);
  
  const itemsToCluster = [...unclusteredItems, ...existingClusterReps];
  
  if (itemsToCluster.length < 2) {
    console.log('[TeamClustering] Not enough items to cluster');
    await cleanupEmptyTeamClusters(subjectId);
    return;
  }

  console.log(`[TeamClustering] Analyzing ${itemsToCluster.length} submissions`);

  const userCreatedClusters = await db
    .select({ id: teamSubmissionClusters.id, name: teamSubmissionClusters.name })
    .from(teamSubmissionClusters)
    .where(
      and(
        eq(teamSubmissionClusters.subjectId, subjectId),
        eq(teamSubmissionClusters.isUserCreated, true)
      )
    );
  
  const userClusterNames = userCreatedClusters.map(c => c.name);
  const userClusterByName = new Map(userCreatedClusters.map(c => [c.name.toLowerCase(), c.id]));

  const clusters = await identifySubmissionClusters(itemsToCluster, userClusterNames);
  
  if (clusters.length === 0) {
    console.log('[TeamClustering] No clusters identified');
    await cleanupEmptyTeamClusters(subjectId);
    return;
  }

  const clusterRepMap = new Map<string, SubmissionItem>();
  for (const rep of existingClusterReps) {
    if (rep.clusterId) {
      clusterRepMap.set(rep.clusterId, rep as SubmissionItem);
    }
  }

  for (const cluster of clusters) {
    if (cluster.submissionIds.length < 2) continue;
    
    const itemsInCluster = itemsToCluster.filter(item => 
      cluster.submissionIds.includes(item.id)
    );
    
    if (itemsInCluster.length < 2) continue;

    const existingClusterId = userClusterByName.get(cluster.clusterName.toLowerCase());
    
    let clusterId: string;
    
    if (existingClusterId) {
      clusterId = existingClusterId;
      console.log(`[TeamClustering] Matched to existing user cluster: "${cluster.clusterName}"`);
    } else {
      const existingRep = itemsInCluster.find(item => item.isClusterRepresentative && item.clusterId);
      
      if (existingRep && existingRep.clusterId) {
        clusterId = existingRep.clusterId;
        await db
          .update(teamSubmissionClusters)
          .set({ name: cluster.clusterName })
          .where(eq(teamSubmissionClusters.id, clusterId));
      } else {
        const [newCluster] = await db
          .insert(teamSubmissionClusters)
          .values({
            name: cluster.clusterName,
            subjectId: subjectId,
            isUserCreated: false,
          })
          .returning();
        clusterId = newCluster.id;
      }
    }
    
    const sortedItems = [...itemsInCluster].sort((a, b) => 
      (b.priority || 0) - (a.priority || 0)
    );
    const representativeId = sortedItems[0].id;
    
    for (const item of itemsInCluster) {
      await db
        .update(teamSubmissions)
        .set({
          clusterId: clusterId,
          isClusterRepresentative: item.id === representativeId,
        })
        .where(eq(teamSubmissions.id, item.id));
    }
    
    console.log(`[TeamClustering] Cluster "${cluster.clusterName}": ${itemsInCluster.length} submissions`);
  }
  
  await cleanupEmptyTeamClusters(subjectId);
  console.log('[TeamClustering] Clustering complete');
}

async function identifySubmissionClusters(items: SubmissionItem[], userClusterNames: string[] = []): Promise<ClusterResult[]> {
  if (items.length < 2) return [];

  const submissionList = items.map((item, idx) => 
    `${idx + 1}. [${item.id}] "${item.headline}" (${item.sourceName || 'Unknown Source'})`
  ).join('\n');

  const userClustersSection = userClusterNames.length > 0 
    ? `\n\nEXISTING TOPIC CLUSTERS (prefer matching to these when applicable):
${userClusterNames.map((name) => `- "${name}"`).join('\n')}

If submissions match any of these existing topics, use the EXACT cluster name from the list above.`
    : '';

  const prompt = `Analyze these news submissions and identify groups that cover THE SAME news event or story. Only group submissions that are about the exact same event, not just the same general topic.

Submissions:
${submissionList}${userClustersSection}

Return a JSON object with a "clusters" key containing an array of clusters. Each cluster should have:
- clusterName: A brief descriptive name for the news event (max 50 chars)
- submissionIds: Array of submission IDs that cover this same event

Only include clusters with 2 or more submissions. If a submission is unique and doesn't match others, don't include it.

Example response:
{"clusters": [
  {"clusterName": "Ukraine Peace Talks in Abu Dhabi", "submissionIds": ["abc123", "def456", "ghi789"]},
  {"clusterName": "Cuba Naval Blockade Consideration", "submissionIds": ["jkl012", "mno345"]}
]}`;

  let content: string | undefined;
  try {
    const response = await withAiTimeout(openai.chat.completions.create({
      model: "gpt-4o-mini-pinned",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'teamSubmissionCluster');

    content = response.choices[0]?.message?.content?.trim();
    if (!content) return [];
  } catch (error) {
    console.error('[TeamClustering] AI call failed for identifySubmissionClusters:', error);
    return [];
  }

  let clusters: ClusterResult[];
  try {
    const parsed = JSON.parse(content);
    clusters = (parsed.clusters ?? parsed) as ClusterResult[];
    if (!Array.isArray(clusters)) return [];
  } catch (parseError) {
    console.error('[TeamClustering] Malformed AI response - JSON parse failed. Raw:', content?.slice(0, 300), parseError);
    return [];
  }

  const validIds = new Set(items.map(i => i.id));
  return clusters
    .filter(c => c.submissionIds && c.submissionIds.length >= 2)
    .map(c => ({
      ...c,
      submissionIds: c.submissionIds.filter(id => validIds.has(id))
    }))
    .filter(c => c.submissionIds.length >= 2);
}

async function cleanupEmptyTeamClusters(subjectId: string): Promise<number> {
  console.log('[TeamClustering] Cleaning up empty clusters...');
  
  const orphanedClusters = await db.execute(sql`
    DELETE FROM team_submission_clusters 
    WHERE subject_id = ${subjectId}
    AND id NOT IN (
      SELECT DISTINCT cluster_id FROM team_submissions WHERE cluster_id IS NOT NULL
    )
    RETURNING id
  `);
  
  const deletedCount = orphanedClusters.rowCount || 0;
  if (deletedCount > 0) {
    console.log(`[TeamClustering] Deleted ${deletedCount} empty clusters`);
  }
  
  return deletedCount;
}

export async function clearAllTeamClusters(): Promise<void> {
  console.log('[TeamClustering] Clearing ALL team submission clusters...');

  await db.execute(sql`
    UPDATE team_submissions 
    SET cluster_id = NULL, is_cluster_representative = false 
    WHERE cluster_id IS NOT NULL
  `);

  const result = await db.execute(sql`DELETE FROM team_submission_clusters RETURNING id`);
  const deletedCount = result.rowCount || 0;
  console.log(`[TeamClustering] Cleared all clusters (${deletedCount} clusters deleted)`);
}

export async function clusterAllActiveTopics(): Promise<void> {
  console.log('[TeamClustering] Running automatic clustering for all active topics...');
  
  const activeTopics = await db
    .select({ id: teamSubjects.id, name: teamSubjects.name })
    .from(teamSubjects)
    .where(eq(teamSubjects.isActive, true));
  
  console.log(`[TeamClustering] Found ${activeTopics.length} active topics to cluster`);
  
  let clusteredCount = 0;
  for (const topic of activeTopics) {
    try {
      await clusterSubmissionsForTopic(topic.id);
      clusteredCount++;
    } catch (error) {
      console.error(`[TeamClustering] Error clustering topic "${topic.name}":`, error);
    }
  }
  
  console.log(`[TeamClustering] Completed clustering for ${clusteredCount}/${activeTopics.length} topics`);
}

// Assign a submission to an existing cluster
export async function assignSubmissionToCluster(submissionId: string, clusterId: string): Promise<void> {
  // Get the cluster to verify it exists
  const [cluster] = await db
    .select()
    .from(teamSubmissionClusters)
    .where(eq(teamSubmissionClusters.id, clusterId));
  
  if (!cluster) {
    throw new Error('Cluster not found');
  }
  
  // Get submission to verify it exists and get its current cluster
  const [submission] = await db
    .select({
      id: teamSubmissions.id,
      subjectId: teamSubmissions.subjectId,
      clusterId: teamSubmissions.clusterId,
      isClusterRepresentative: teamSubmissions.isClusterRepresentative,
    })
    .from(teamSubmissions)
    .where(eq(teamSubmissions.id, submissionId));
  
  if (!submission) {
    throw new Error('Submission not found');
  }
  
  // Verify submission subject matches cluster subject
  if (submission.subjectId !== cluster.subjectId) {
    throw new Error('Submission must belong to the same topic as the cluster');
  }
  
  const oldClusterId = submission.clusterId;
  const wasRepresentative = submission.isClusterRepresentative;
  
  // Update the submission
  await db
    .update(teamSubmissions)
    .set({
      clusterId: clusterId,
      isClusterRepresentative: false,
    })
    .where(eq(teamSubmissions.id, submissionId));
  
  // If this was the representative of the old cluster, assign a new one
  if (wasRepresentative && oldClusterId) {
    const [newRep] = await db
      .select({ id: teamSubmissions.id, priority: teamSubmissions.priorityScore })
      .from(teamSubmissions)
      .where(eq(teamSubmissions.clusterId, oldClusterId))
      .orderBy(sql`priority_score DESC NULLS LAST`)
      .limit(1);
    
    if (newRep) {
      await db
        .update(teamSubmissions)
        .set({ isClusterRepresentative: true })
        .where(eq(teamSubmissions.id, newRep.id));
    }
    
    // Cleanup empty old cluster
    await cleanupSingleCluster(oldClusterId);
  }
  
  console.log(`[TeamClustering] Assigned submission ${submissionId} to cluster "${cluster.name}"`);
}

// Create a new cluster with a submission
export async function createClusterWithSubmission(submissionId: string, clusterName: string, subjectId: string): Promise<string> {
  // Get submission to verify it belongs to the specified subject
  const [submission] = await db
    .select({
      id: teamSubmissions.id,
      subjectId: teamSubmissions.subjectId,
      clusterId: teamSubmissions.clusterId,
      isClusterRepresentative: teamSubmissions.isClusterRepresentative,
    })
    .from(teamSubmissions)
    .where(eq(teamSubmissions.id, submissionId));
  
  if (!submission) {
    throw new Error('Submission not found');
  }
  
  if (submission.subjectId !== subjectId) {
    throw new Error('Submission must belong to the specified topic');
  }
  
  const oldClusterId = submission.clusterId;
  const wasRepresentative = submission.isClusterRepresentative;
  
  // Create new cluster
  const [newCluster] = await db
    .insert(teamSubmissionClusters)
    .values({
      name: clusterName,
      subjectId: subjectId,
      isUserCreated: true,
    })
    .returning();
  
  // Assign submission as representative
  await db
    .update(teamSubmissions)
    .set({
      clusterId: newCluster.id,
      isClusterRepresentative: true,
    })
    .where(eq(teamSubmissions.id, submissionId));
  
  // If this was the representative of an old cluster, assign a new one
  if (wasRepresentative && oldClusterId) {
    const [newRep] = await db
      .select({ id: teamSubmissions.id })
      .from(teamSubmissions)
      .where(eq(teamSubmissions.clusterId, oldClusterId))
      .orderBy(sql`priority_score DESC NULLS LAST`)
      .limit(1);
    
    if (newRep) {
      await db
        .update(teamSubmissions)
        .set({ isClusterRepresentative: true })
        .where(eq(teamSubmissions.id, newRep.id));
    }
    
    // Cleanup empty old cluster
    await cleanupSingleCluster(oldClusterId);
  }
  
  console.log(`[TeamClustering] Created new cluster "${clusterName}" with submission ${submissionId}`);
  return newCluster.id;
}

// Unlink a submission from its cluster
export async function unlinkSubmissionFromCluster(submissionId: string): Promise<void> {
  // Get current submission info
  const [submission] = await db
    .select({
      clusterId: teamSubmissions.clusterId,
      isClusterRepresentative: teamSubmissions.isClusterRepresentative,
    })
    .from(teamSubmissions)
    .where(eq(teamSubmissions.id, submissionId));
  
  if (!submission || !submission.clusterId) {
    console.log(`[TeamClustering] Submission ${submissionId} is not in a cluster`);
    return;
  }
  
  const clusterId = submission.clusterId;
  
  // Remove from cluster
  await db
    .update(teamSubmissions)
    .set({
      clusterId: null,
      isClusterRepresentative: false,
    })
    .where(eq(teamSubmissions.id, submissionId));
  
  // If this was the representative, assign a new one based on priority
  if (submission.isClusterRepresentative) {
    const [newRep] = await db
      .select({ id: teamSubmissions.id })
      .from(teamSubmissions)
      .where(eq(teamSubmissions.clusterId, clusterId))
      .orderBy(sql`priority_score DESC NULLS LAST`)
      .limit(1);
    
    if (newRep) {
      await db
        .update(teamSubmissions)
        .set({ isClusterRepresentative: true })
        .where(eq(teamSubmissions.id, newRep.id));
    }
  }
  
  // Cleanup empty cluster
  await cleanupSingleCluster(clusterId);
  
  console.log(`[TeamClustering] Unlinked submission ${submissionId} from cluster ${clusterId}`);
}

// Cleanup a single cluster if it has no members
async function cleanupSingleCluster(clusterId: string): Promise<void> {
  const members = await db
    .select({ id: teamSubmissions.id })
    .from(teamSubmissions)
    .where(eq(teamSubmissions.clusterId, clusterId))
    .limit(1);
  
  if (members.length === 0) {
    await db
      .delete(teamSubmissionClusters)
      .where(eq(teamSubmissionClusters.id, clusterId));
    console.log(`[TeamClustering] Deleted empty cluster ${clusterId}`);
  }
}

// Get all clusters across all topics for moving submissions
export async function getAllTeamClusters() {
  const clusters = await db
    .select({
      id: teamSubmissionClusters.id,
      name: teamSubmissionClusters.name,
      subjectId: teamSubmissionClusters.subjectId,
    })
    .from(teamSubmissionClusters);
  
  // Get member counts for each cluster
  const clusterCounts = await db
    .select({
      clusterId: teamSubmissions.clusterId,
      count: sql<number>`count(*)`,
    })
    .from(teamSubmissions)
    .where(sql`${teamSubmissions.clusterId} IS NOT NULL`)
    .groupBy(teamSubmissions.clusterId);
  
  const countMap = new Map(clusterCounts.map(c => [c.clusterId, Number(c.count)]));
  
  return clusters.map(cluster => ({
    ...cluster,
    memberCount: countMap.get(cluster.id) || 0,
  }));
}

export async function getClusteredSubmissionsForTopic(subjectId: string) {
  const submissions = await db
    .select({
      id: teamSubmissions.id,
      chatMessageId: teamSubmissions.chatMessageId,
      submittedBy: teamSubmissions.submittedBy,
      submittedByName: teamSubmissions.submittedByName,
      sourceType: teamSubmissions.sourceType,
      sourceUrl: teamSubmissions.sourceUrl,
      sourceName: teamSubmissions.sourceName,
      headline: teamSubmissions.headline,
      summary: teamSubmissions.summary,
      subjectId: teamSubmissions.subjectId,
      priorityScore: teamSubmissions.priorityScore,
      status: teamSubmissions.status,
      publishedAt: teamSubmissions.publishedAt,
      mcopSubmittedAt: teamSubmissions.mcopSubmittedAt,
      joeEmailedAt: teamSubmissions.joeEmailedAt,
      createdAt: teamSubmissions.createdAt,
      updatedAt: teamSubmissions.updatedAt,
      clusterId: teamSubmissions.clusterId,
      isClusterRepresentative: teamSubmissions.isClusterRepresentative,
    })
    .from(teamSubmissions)
    .where(
      and(
        eq(teamSubmissions.subjectId, subjectId),
        isNull(teamSubmissions.deletedAt)
      )
    );

  const clusters = await db
    .select()
    .from(teamSubmissionClusters)
    .where(eq(teamSubmissionClusters.subjectId, subjectId));

  const clusterMap = new Map(clusters.map(c => [c.id, c]));

  const clusteredSubmissions: Array<{
    clusterId: string | null;
    clusterName: string | null;
    isRepresentative: boolean;
    submissions: typeof submissions;
  }> = [];

  const clusterGroups = new Map<string, typeof submissions>();
  const unclustered: typeof submissions = [];

  for (const sub of submissions) {
    if (sub.clusterId) {
      const group = clusterGroups.get(sub.clusterId) || [];
      group.push(sub);
      clusterGroups.set(sub.clusterId, group);
    } else {
      unclustered.push(sub);
    }
  }

  for (const [clusterId, subs] of Array.from(clusterGroups.entries())) {
    const cluster = clusterMap.get(clusterId);
    const sortedSubs = [...subs].sort((a, b) => {
      if (a.isClusterRepresentative) return -1;
      if (b.isClusterRepresentative) return 1;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });
    
    clusteredSubmissions.push({
      clusterId,
      clusterName: cluster?.name || 'Unknown Cluster',
      isRepresentative: true,
      submissions: sortedSubs,
    });
  }

  clusteredSubmissions.sort((a, b) => {
    const aMaxPriority = Math.max(...a.submissions.map(s => s.priorityScore || 0));
    const bMaxPriority = Math.max(...b.submissions.map(s => s.priorityScore || 0));
    return bMaxPriority - aMaxPriority;
  });

  for (const sub of unclustered) {
    clusteredSubmissions.push({
      clusterId: null,
      clusterName: null,
      isRepresentative: false,
      submissions: [sub],
    });
  }

  return clusteredSubmissions;
}
