
// Backdrop blur (`fast/backdrop.rs`): draws a blurred copy of the target's
// pixels back inside a rounded rectangle, or fills the rectangle with the
// backdrop's fallback colour. Appended to the upstream shaders by
// `fast/rounded_clip_shader.rs`, which also gives both fragments the
// enclosing rounded clips.

struct BackdropUniforms {
  // The rectangle, then the content mask, as left, top, right, bottom in
  // device pixels.
  float4 bounds;
  float4 clip;
  // Top left, top right, bottom right, bottom left.
  float4 radii;
  float4 fallback;
  float2 viewport;
  // Where the blurred texture's first texel is in the target.
  float2 source_origin;
  float opacity;
  float padding[3];
};

struct BackdropVarying {
  float4 position [[position]];
};

vertex BackdropVarying backdrop_vertex(
    uint vertex_id [[vertex_id]],
    constant BackdropUniforms &uniforms [[buffer(0)]]) {
  // Two triangles, (0, 1, 2) and (3, 4, 5), over the unit square.
  float2 corner = float2(float(vertex_id == 1 || vertex_id == 4 || vertex_id == 5),
                         float(vertex_id == 2 || vertex_id == 3 || vertex_id == 5));
  float4 area = float4(max(uniforms.bounds.xy, uniforms.clip.xy),
                       min(uniforms.bounds.zw, uniforms.clip.zw));
  float2 pixel = mix(area.xy, area.zw, corner);
  BackdropVarying out;
  out.position = float4(pixel / uniforms.viewport * float2(2., -2.) + float2(-1., 1.), 0., 1.);
  return out;
}

// How much of the pixel centred at `position` the rounded rectangle and the
// content mask cover.
float backdrop_coverage(float2 position, constant BackdropUniforms &uniforms) {
  if (any(position < uniforms.clip.xy) || any(position > uniforms.clip.zw)) {
    return 0.;
  }
  float2 half_size = (uniforms.bounds.zw - uniforms.bounds.xy) * 0.5;
  float2 from_center = position - (uniforms.bounds.xy + half_size);
  float radius = from_center.x < 0.
      ? (from_center.y < 0. ? uniforms.radii.x : uniforms.radii.w)
      : (from_center.y < 0. ? uniforms.radii.y : uniforms.radii.z);
  radius = min(radius, min(half_size.x, half_size.y));
  float2 corner = abs(from_center) - half_size + radius;
  float distance = length(max(corner, 0.)) + min(max(corner.x, corner.y), 0.) - radius;
  return saturate(0.5 - distance);
}

fragment float4 backdrop_blur_fragment(
    BackdropVarying input [[stage_in]],
    constant BackdropUniforms &uniforms [[buffer(0)]],
    texture2d<float> blurred [[texture(0)]]) {
  float coverage = backdrop_coverage(input.position.xy, uniforms) * uniforms.opacity;
  uint2 texel = uint2(max(input.position.xy - uniforms.source_origin, float2(0.)));
  texel = min(texel, uint2(blurred.get_width() - 1, blurred.get_height() - 1));
  float4 color = blurred.read(texel);
  // The target holds premultiplied colour; the pipeline blends straight.
  float3 straight = color.a > 0. ? color.rgb / color.a : float3(0.);
  return float4(straight, color.a * coverage);
}

fragment float4 backdrop_fill_fragment(
    BackdropVarying input [[stage_in]],
    constant BackdropUniforms &uniforms [[buffer(0)]]) {
  float coverage = backdrop_coverage(input.position.xy, uniforms) * uniforms.opacity;
  return float4(uniforms.fallback.rgb, uniforms.fallback.a * coverage);
}
