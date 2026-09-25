/** SCREEN-007 加载态：素材网格与右栏的骨架（同 ⑤ 的封面骨架），不是一行「读取素材…」（8.4 审查 LOW / Task 9.3） */
export function AssetReviewSkeleton() {
  return (
    <section aria-label="读取素材" aria-busy className="flex flex-col gap-4">
      <div className="h-8 w-64 animate-pulse rounded-sm bg-surface" />
      <div className="flex gap-4">
        <ul className="grid min-w-0 basis-[65%] grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex flex-col gap-1.5">
              <div className="aspect-square w-full animate-pulse rounded-md bg-surface" />
              <div className="h-3 w-3/4 animate-pulse rounded-sm bg-surface" />
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 basis-[35%] flex-col gap-3">
          <div className="h-48 animate-pulse rounded-md bg-surface" />
          <div className="h-24 animate-pulse rounded-md bg-surface" />
        </div>
      </div>
    </section>
  );
}
