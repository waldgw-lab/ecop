import CategoryBadge from '../CategoryBadge';

export default function CategoryBadgeExample() {
  return (
    <div className="flex flex-wrap gap-2">
      <CategoryBadge category="DEFENSE" />
      <CategoryBadge category="CONFLICT" />
      <CategoryBadge category="POLICY" />
      <CategoryBadge category="VETERANS" />
      <CategoryBadge category="INTEL" />
      <CategoryBadge category="GLOBAL" />
    </div>
  );
}
