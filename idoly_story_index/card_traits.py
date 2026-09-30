"""Card filter metadata from Card parameters and actual Skill categories."""


def card_traits(card, skills):
    parameters = {key: card[key+'RatioPermil'] for key in ['vocal', 'dance', 'visual']}
    highest = max(parameters.values())
    attributes = [key for key, value in parameters.items() if value == highest]
    return {
        'attribute': attributes[0] if len(attributes) == 1 else None,
        'role': {1: 'scorer', 2: 'buffer', 3: 'supporter'}.get(card['type']),
        'hasSp': any(skills.get(card.get('skillId'+str(i)), {}).get('categoryType') == 1
                     for i in range(1, 5)),
    }
