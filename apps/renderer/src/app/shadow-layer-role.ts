/** Older plans did not store a role. Only migrate an explicitly shadow-only
 * description; merely mentioning that an object casts a shadow is insufficient. */
export function isShadowOnlyLayer(plan:Readonly<Record<string,unknown>>):boolean{
  if(plan.kind==='background'||plan.layerKind==='background')return false;
  const name=String(plan.name??''),description=String(plan.description??'');
  return /^shadow[-_]/iu.test(String(plan.layerId??''))
    && /(?:阴影|投影|倒影|反射|反光|shadow|reflection)/iu.test(name)
    && /(?:仅|only)/iu.test(description)
    && /(?:不含|不包含).{0,30}(?:本体|本身|机身|机器|产品|水果|物体|餐盘|甜点|花瓶|咖啡机)|(?:without|excluding).{0,40}(?:object|subject|product)/iu.test(description);
}
