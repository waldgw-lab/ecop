import HeadlineCard from '../HeadlineCard';

export default function HeadlineCardExample() {
  return (
    <div className="space-y-4 max-w-3xl">
      <HeadlineCard
        id="1"
        title="Pentagon Announces New Defense Strategy for Indo-Pacific Region"
        url="https://drudgereport.com"
        category="DEFENSE"
        timestamp="15m ago"
      />
      <HeadlineCard
        id="2"
        title="NATO Forces Conduct Large-Scale Training Exercise in Eastern Europe"
        url="https://drudgereport.com"
        category="GLOBAL"
        timestamp="1h ago"
      />
    </div>
  );
}
