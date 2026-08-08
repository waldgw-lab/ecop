import { Badge } from "@/components/ui/badge";

interface CategoryBadgeProps {
  category: string;
}

const categoryColors: Record<string, string> = {
  DEFENSE: 'bg-blue-600 text-white border-blue-700',
  CONFLICT: 'bg-red-600 text-white border-red-700',
  POLICY: 'bg-purple-600 text-white border-purple-700',
  VETERANS: 'bg-green-600 text-white border-green-700',
  INTEL: 'bg-orange-600 text-white border-orange-700',
  GLOBAL: 'bg-cyan-600 text-white border-cyan-700',
  DOMESTIC: 'bg-indigo-600 text-white border-indigo-700',
};

export default function CategoryBadge({ category }: CategoryBadgeProps) {
  if (!category) return null;
  
  const colorClass = categoryColors[category] || 'bg-gray-600 text-white border-gray-700';
  
  return (
    <Badge 
      className={`${colorClass} px-3 py-0.5 text-xs font-semibold uppercase tracking-wider no-default-hover-elevate no-default-active-elevate`}
      data-testid={`badge-category-${category.toLowerCase()}`}
    >
      {category}
    </Badge>
  );
}
