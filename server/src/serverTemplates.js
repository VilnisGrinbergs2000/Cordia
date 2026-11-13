const SERVER_TEMPLATES = [
  {
    id: 'community',
    name: 'Community',
    description: 'A friendly home base for introductions, updates, and everyday chat.',
    icon: 'users',
    color: '#6d5efc',
    categories: [
      {
        name: 'Text channels',
        channels: [
          { name: 'general', type: 'text' },
          { name: 'announcements', type: 'text' },
          { name: 'introductions', type: 'text' }
        ]
      },
      {
        name: 'Voice channels',
        channels: [
          { name: 'lounge', type: 'voice' },
          { name: 'community-stage', type: 'voice' }
        ]
      }
    ]
  },
  {
    id: 'gaming',
    name: 'Gaming',
    description: 'Squad up with a lobby, looking-for-group chat, and clip sharing.',
    icon: 'gamepad',
    color: '#2f7df6',
    categories: [
      {
        name: 'Text channels',
        channels: [
          { name: 'general', type: 'text' },
          { name: 'looking-for-group', type: 'text' },
          { name: 'clips-and-highlights', type: 'text' }
        ]
      },
      {
        name: 'Voice channels',
        channels: [
          { name: 'game-lobby', type: 'voice' },
          { name: 'afk', type: 'voice' }
        ]
      }
    ]
  },
  {
    id: 'study',
    name: 'Study group',
    description: 'Keep notes, ask questions, and focus together in quiet rooms.',
    icon: 'graduation',
    color: '#2f9e6f',
    categories: [
      {
        name: 'Text channels',
        channels: [
          { name: 'general', type: 'text' },
          { name: 'resources', type: 'text' },
          { name: 'questions', type: 'text' }
        ]
      },
      {
        name: 'Voice channels',
        channels: [
          { name: 'study-room', type: 'voice' },
          { name: 'quiet-focus', type: 'voice' }
        ]
      }
    ]
  },
  {
    id: 'team',
    name: 'Team project',
    description: 'Plan work, share updates, and meet in a standup room.',
    icon: 'briefcase',
    color: '#e5673b',
    categories: [
      {
        name: 'Text channels',
        channels: [
          { name: 'general', type: 'text' },
          { name: 'announcements', type: 'text' },
          { name: 'tasks', type: 'text' }
        ]
      },
      {
        name: 'Voice channels',
        channels: [
          { name: 'standup', type: 'voice' },
          { name: 'war-room', type: 'voice' }
        ]
      }
    ]
  },
  {
    id: 'creative',
    name: 'Creative studio',
    description: 'Showcase work, trade feedback, and jam in a shared studio.',
    icon: 'palette',
    color: '#d9538a',
    categories: [
      {
        name: 'Text channels',
        channels: [
          { name: 'general', type: 'text' },
          { name: 'showcase', type: 'text' },
          { name: 'feedback', type: 'text' }
        ]
      },
      {
        name: 'Voice channels',
        channels: [
          { name: 'studio', type: 'voice' },
          { name: 'open-mic', type: 'voice' }
        ]
      }
    ]
  },
  {
    id: 'blank',
    name: 'Start from scratch',
    description: 'Just #general and a lounge. Add your own channels later.',
    icon: 'sparkles',
    color: '#7a8798',
    categories: [
      {
        name: 'Text channels',
        channels: [{ name: 'general', type: 'text' }]
      },
      {
        name: 'Voice channels',
        channels: [{ name: 'lounge', type: 'voice' }]
      }
    ]
  }
];

const TEMPLATES_BY_ID = new Map(SERVER_TEMPLATES.map((template) => [template.id, template]));

function getServerTemplate(id) {
  return TEMPLATES_BY_ID.get(String(id || '').trim()) || null;
}

function listServerTemplates() {
  return SERVER_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    icon: template.icon,
    color: template.color,
    categories: template.categories.map((category) => ({
      name: category.name,
      channels: category.channels.map((channel) => ({ ...channel }))
    }))
  }));
}

module.exports = {
  SERVER_TEMPLATES,
  getServerTemplate,
  listServerTemplates
};
