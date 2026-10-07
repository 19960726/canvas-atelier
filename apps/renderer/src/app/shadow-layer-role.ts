/** Older plans did not store a role. Only migrate an explicitly shadow-only
 * description; merely mentioning that an object casts a shadow is insufficient. */
export function isShadowOnlyLayer(plan:Readonly<Record<string,unknown>>):boolean{
  if(plan.kind==='background'||plan.layerKind==='background')return false;
  const name=String(plan.name??''),description=String(plan.description??'');
  const shadowTerm=/(?:阴影|投影(?!仪)|倒影|反射(?!镜|器)|反光(?!板|纸|器)|\bshadows?\b|\breflections?\b)/iu;
  const exclusion=/(?:不含|不包含|without|excluding)/iu.exec(description);
  if(!exclusion||!shadowTerm.test(name))return false;
  const scopeSeparator=/(?:[、,，;；。.!?&/]|以及|及|与|和|\b(?:and|with|plus)\b)/iu;
  const namedScopes=name.split(scopeSeparator).filter(scope=>scope.trim());
  if(namedScopes.some(scope=>!shadowTerm.test(scope)))return false;
  const included=description.slice(0,exclusion.index);
  if(/(?:不\s*仅|不\s*只|并非\s*仅|\bnot\s+only\b)/iu.test(included)
    ||!/(?:仅|\bonly\b)/iu.test(included)||!shadowTerm.test(included)
    ||/(?:本体|本身|机身|\bbody\b|\bitself\b)/iu.test(included))return false;
  // Only this complete, independently checked historical fruit-shadow contract
  // has a known shared subject list. Unknown lists must retain object checking.
  const knownFruitSubjects=name.trim()==='柑橘水果投影与倒影'
    && description.trim()==='仅右侧西柚切片、整果及薄荷叶在台面上的接触阴影与倒影，不含水果本体';
  const requested=knownFruitSubjects?included.replace('仅右侧西柚切片、整果及薄荷叶','仅水果'):included;
  const scopes=requested.replace(/与(?=[^、,，;；及与和]{1,30}(?:接触|相接)[^、,，;；及与和]{0,10}(?:阴影|投影|倒影))/gu,' ')
    .split(scopeSeparator).filter(scope=>scope.trim());
  if(scopes.some(scope=>!shadowTerm.test(scope)))return false;
  // Excluding other objects does not exclude the subject whose matte is here.
  const excluded=description.slice(exclusion.index);
  const subjectExclusion=/^(?:(?:不含|不包含)(.{0,30}?)(本体|本身|机身|机器|产品|水果|物体|餐盘|甜点|花瓶|咖啡机)|(?:without|excluding)(.{0,40}?)(object|subject|product))/iu.exec(excluded);
  if(!subjectExclusion
    ||/(?:其他|其它|其余|别的|之外|以外|\b(?:other|another|unrelated)\b)/iu.test(subjectExclusion[1]??subjectExclusion[3]??'')
    ||/\b(?:objects?|subjects?|products?)\s+(?:other\s+than|except)\b/iu.test(excluded))return false;
  const subject=subjectExclusion[2]
    ? `${subjectExclusion[1]}${/^(?:本体|本身|机身)$/u.test(subjectExclusion[2])?'':subjectExclusion[2]}`.trim()
    : subjectExclusion[3]!.trim().replace(/^(?:(?:the|a|an|this|that|its)\s+)+/iu,'');
  const mentionsSubject=(scope:string)=>/^[a-z]/iu.test(subject)
    ? new RegExp(`(?:^|[^a-z0-9])${subject.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}(?=$|[^a-z0-9])`,'iu').test(scope)
    : scope.includes(subject);
  if(!subject)return true; // An unnamed object/body is explicitly excluded.
  return mentionsSubject(namedScopes[0]!); // Nearby props in the description are not this effect's subject.
}
