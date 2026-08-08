import { useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isCandidateHeadlineTruncated } from "@/lib/curatedCandidateContext";

type OverflowHeadlineTooltipProps = {
  text: string;
  className?: string;
  testId?: string;
};

export default function OverflowHeadlineTooltip({
  text,
  className,
  testId,
}: OverflowHeadlineTooltipProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [truncated, setTruncated] = useState(false);

  const handlePointerEnter = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.pointerType !== "mouse") return;
    const element = textRef.current;
    const overflows = !!element && isCandidateHeadlineTruncated(
      element.scrollWidth,
      element.clientWidth,
    );
    setTruncated(overflows);
    setOpen(overflows);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip
        open={open}
        onOpenChange={(nextOpen) => {
          // Candidate rows are focusable buttons. Ignore Radix focus-open events:
          // this disclosure is desktop-hover-only and must never appear when the
          // surrounding dialog auto-focuses a row.
          if (!nextOpen) setOpen(false);
        }}
      >
        <TooltipTrigger asChild>
          <span
            ref={textRef}
            className={className}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={() => setOpen(false)}
            onFocus={() => setOpen(false)}
            data-testid={testId}
          >
            {text}
          </span>
        </TooltipTrigger>
        {truncated && (
          <TooltipContent
            side="top"
            align="start"
            collisionPadding={12}
            className="max-w-[min(32rem,calc(100vw-2rem))] whitespace-normal break-words text-sm leading-snug"
            data-testid={testId ? `${testId}-full` : undefined}
          >
            {text}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}