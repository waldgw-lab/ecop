import TopStories from '../TopStories';

const mockTopStories = [
  {
    id: 'top-1',
    title: 'Pentagon Announces Major Overhaul of Indo-Pacific Defense Strategy',
    url: 'https://drudgereport.com',
    category: 'DEFENSE',
    source: 'The Wall Street Journal',
    summary: 'Defense officials outline comprehensive restructuring of military assets in the Pacific region in response to evolving regional threats.',
    importance: 'critical' as const,
    timestamp: '2h ago',
  },
  {
    id: 'top-2',
    title: 'NATO Summit: Alliance Leaders Commit to Increased Defense Spending',
    url: 'https://drudgereport.com',
    category: 'GLOBAL',
    source: 'Reuters',
    summary: 'Allied nations agree to boost defense budgets by 15% over next three years amid heightened security concerns.',
    importance: 'critical' as const,
    timestamp: '4h ago',
  },
  {
    id: 'top-3',
    title: 'New Intelligence Report Warns of Emerging Cyber Warfare Threats',
    url: 'https://drudgereport.com',
    category: 'INTEL',
    source: 'The Washington Post',
    summary: 'Classified briefing reveals sophisticated adversary capabilities targeting critical infrastructure and military communications.',
    importance: 'high' as const,
    timestamp: '6h ago',
  },
  {
    id: 'top-4',
    title: 'Congress Debates Military Aid Package for Allied Nations',
    url: 'https://drudgereport.com',
    category: 'POLICY',
    source: 'Politico',
    summary: 'Bipartisan legislation proposes $45 billion in military assistance, facing opposition from budget hawks.',
    importance: 'high' as const,
    timestamp: '8h ago',
  },
  {
    id: 'top-5',
    title: 'Tensions Rise in Middle East: Military Forces on High Alert',
    url: 'https://drudgereport.com',
    category: 'CONFLICT',
    source: 'CNN',
    summary: 'Regional military commanders increase readiness posture following intelligence indicating potential escalation.',
    importance: 'critical' as const,
    timestamp: '12h ago',
  },
];

export default function TopStoriesExample() {
  return (
    <div className="max-w-4xl">
      <TopStories stories={mockTopStories} />
    </div>
  );
}
