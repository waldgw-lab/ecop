import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

interface StatusIndicatorProps {
  isLive: boolean;
  lastUpdated: string;
  lastUpdatedTimestamp?: Date;
}

export default function StatusIndicator({ isLive, lastUpdated, lastUpdatedTimestamp }: StatusIndicatorProps) {
  const formatTimestamp = (timestamp: Date) => {
    const easternFormatted = formatInTimeZone(timestamp, "America/New_York", "HH:mm:ss 'ET' (MMM dd, yyyy)");
    const zuluFormatted = formatInTimeZone(timestamp, "UTC", "HH:mm:ss 'Z'");
    
    return { eastern: easternFormatted, zulu: zuluFormatted };
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${isLive ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} data-testid="status-indicator-dot" />
        <span className="text-sm font-medium font-mono uppercase tracking-wider" data-testid="text-status">
          {isLive ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground font-mono" data-testid="text-last-updated">
          Updated {lastUpdated}
        </span>
        {lastUpdatedTimestamp && (
          <span className="text-xs text-muted-foreground font-mono" data-testid="text-timestamp-detail">
            {formatTimestamp(lastUpdatedTimestamp).eastern} / {formatTimestamp(lastUpdatedTimestamp).zulu}
          </span>
        )}
      </div>
    </div>
  );
}
