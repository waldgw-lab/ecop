import HeadlineFeed from '../HeadlineFeed';

const mockHeadlines = [
  {
    id: '1',
    title: 'Pentagon Announces New Defense Strategy for Indo-Pacific Region',
    url: 'https://drudgereport.com',
    category: 'DEFENSE',
    timestamp: '15m ago',
  },
  {
    id: '2',
    title: 'NATO Forces Conduct Large-Scale Training Exercise in Eastern Europe',
    url: 'https://drudgereport.com',
    category: 'GLOBAL',
    timestamp: '32m ago',
  },
  {
    id: '3',
    title: 'Veterans Affairs Announces New Mental Health Initiative',
    url: 'https://drudgereport.com',
    category: 'VETERANS',
    timestamp: '45m ago',
  },
  {
    id: '4',
    title: 'Intelligence Report Reveals New Cyber Threat Landscape',
    url: 'https://drudgereport.com',
    category: 'INTEL',
    timestamp: '2h ago',
  },
  {
    id: '5',
    title: 'Congressional Committee Reviews Defense Budget Proposal',
    url: 'https://drudgereport.com',
    category: 'POLICY',
    timestamp: '3h ago',
  },
];

export default function HeadlineFeedExample() {
  return (
    <div className="max-w-3xl">
      <HeadlineFeed headlines={mockHeadlines} />
    </div>
  );
}
