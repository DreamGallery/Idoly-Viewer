"""Resolve the texture exposed by a Unity bundle, including same-named variants."""
def select_texture(env, name):
    # UnityPy ContainerHelper supports indexing, but older releases have no get().
    try:
        reference = env.container[name]
    except KeyError:
        reference = None
    if reference is not None and reference.type.name == 'Texture2D':
        return reference.read()
    candidates = [obj.read() for obj in env.objects if obj.type.name == 'Texture2D']
    exact = [obj for obj in candidates if obj.m_Name == name]
    if len(exact) == 1:
        return exact[0]
    if len(candidates) == 1:
        return candidates[0]
    raise ValueError('Ambiguous texture without a bundle reference')
