import { useEffect, useRef, useState } from "react";

interface AutoScrollContainerProps {
  children: React.ReactNode;
  speed?: number;
  pauseOnHover?: boolean;
}

export default function AutoScrollContainer({ 
  children, 
  speed = 30,
  pauseOnHover = true 
}: AutoScrollContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let animationFrameId: number;
    let lastTimestamp = 0;

    const scroll = (timestamp: number) => {
      if (!lastTimestamp) lastTimestamp = timestamp;
      const delta = timestamp - lastTimestamp;

      if (!isPaused && container) {
        const maxScroll = container.scrollHeight - container.clientHeight;
        
        if (maxScroll > 0) {
          const newScrollTop = container.scrollTop + (speed * delta) / 1000;
          
          if (newScrollTop >= maxScroll) {
            // Reset to top when reaching bottom
            container.scrollTop = 0;
          } else {
            container.scrollTop = newScrollTop;
          }
        }
      }

      lastTimestamp = timestamp;
      animationFrameId = requestAnimationFrame(scroll);
    };

    animationFrameId = requestAnimationFrame(scroll);

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isPaused, speed]);

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => pauseOnHover && setIsPaused(true)}
      onMouseLeave={() => pauseOnHover && setIsPaused(false)}
      className="overflow-hidden"
      style={{ maxHeight: '600px' }}
      data-testid="auto-scroll-container"
    >
      {children}
    </div>
  );
}
