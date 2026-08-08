import AutoScrollContainer from '../AutoScrollContainer';

export default function AutoScrollContainerExample() {
  const items = Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`);
  
  return (
    <AutoScrollContainer speed={40}>
      <div className="space-y-2 p-4">
        {items.map((item, index) => (
          <div key={index} className="p-4 bg-card border rounded-md">
            {item} - This is a demo of auto-scrolling content
          </div>
        ))}
      </div>
    </AutoScrollContainer>
  );
}
