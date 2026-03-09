import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  principles: string[];
  bestPractices: string[];
  antiPatterns: string[];
  frameworks: string[];
  isSystem: boolean;
}

type Mode = 'list' | 'detail' | 'create' | 'edit' | 'delete';
type CreateStep = 'name' | 'category' | 'description';

const CATEGORIES = ['engineering', 'security', 'testing', 'architecture', 'devops', 'data', 'design', 'general'];

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [message, setMessage] = useState<string | null>(null);

  // Create/edit state
  const [createStep, setCreateStep] = useState<CreateStep>('name');
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('engineering');
  const [formDescription, setFormDescription] = useState('');
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);

  const fetchSkills = async () => {
    try {
      const data = await api.get<{ skills: Skill[] }>('/skills');
      setSkills(data?.skills || []);
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, []);

  const resetForm = () => {
    setFormName('');
    setFormCategory('engineering');
    setFormDescription('');
    setCategoryIndex(0);
    setCreateStep('name');
    setEditId(null);
  };

  const itemCount = (s: Skill) =>
    (s.principles?.length || 0) +
    (s.bestPractices?.length || 0) +
    (s.antiPatterns?.length || 0) +
    (s.frameworks?.length || 0);

  useInput((input, key) => {
    // Delete confirmation mode
    if (mode === 'delete') {
      if (input === 'y') {
        const skill = skills[selected];
        if (skill) {
          api.delete(`/skills/${skill.id}`).then(() => {
            setMessage(`Deleted "${skill.name}"`);
            fetchSkills();
            setTimeout(() => setMessage(null), 3000);
          }).catch(() => setMessage('Failed to delete'));
        }
        setMode('list');
      } else if (input === 'n' || key.escape) {
        setMode('list');
      }
      return;
    }

    // Create/edit mode input handling
    if (mode === 'create' || mode === 'edit') {
      if (key.escape) {
        resetForm();
        setMode('list');
        return;
      }

      if (createStep === 'category') {
        if (key.upArrow || input === 'k') {
          setCategoryIndex(i => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setCategoryIndex(i => Math.min(CATEGORIES.length - 1, i + 1));
          return;
        }
        if (key.return) {
          setFormCategory(CATEGORIES[categoryIndex]);
          setCreateStep('description');
          return;
        }
        return;
      }

      // Text input for name and description
      if (key.return) {
        if (createStep === 'name') {
          if (formName.trim()) {
            setCreateStep('category');
          }
          return;
        }
        if (createStep === 'description') {
          if (formDescription.trim()) {
            const body = {
              name: formName.trim(),
              category: formCategory,
              description: formDescription.trim(),
            };
            if (mode === 'create') {
              api.post('/skills', body).then(() => {
                setMessage('Skill created!');
                fetchSkills();
                setTimeout(() => setMessage(null), 3000);
              }).catch(() => setMessage('Failed to create skill'));
            } else {
              api.put(`/skills/${editId}`, body).then(() => {
                setMessage('Skill updated!');
                fetchSkills();
                setTimeout(() => setMessage(null), 3000);
              }).catch(() => setMessage('Failed to update skill'));
            }
            resetForm();
            setMode('list');
          }
          return;
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (createStep === 'name') setFormName(s => s.slice(0, -1));
        if (createStep === 'description') setFormDescription(s => s.slice(0, -1));
        return;
      }

      // Append printable characters
      if (input && !key.ctrl && !key.meta) {
        if (createStep === 'name') setFormName(s => s + input);
        if (createStep === 'description') setFormDescription(s => s + input);
      }
      return;
    }

    // Detail mode
    if (mode === 'detail') {
      if (key.escape || key.return) {
        setMode('list');
      }
      return;
    }

    // List mode navigation
    if ((key.upArrow || input === 'k') && selected > 0) setSelected(s => s - 1);
    if ((key.downArrow || input === 'j') && selected < skills.length - 1) setSelected(s => s + 1);

    if (key.return && skills[selected]) {
      setMode('detail');
    }

    if (input === 'n') {
      resetForm();
      setMode('create');
    }

    if (input === 'e' && skills[selected] && !skills[selected].isSystem) {
      const skill = skills[selected];
      setFormName(skill.name);
      setFormCategory(skill.category);
      setFormDescription(skill.description);
      setCategoryIndex(Math.max(0, CATEGORIES.indexOf(skill.category)));
      setEditId(skill.id);
      setCreateStep('name');
      setMode('edit');
    }

    if (input === 'd' && skills[selected] && !skills[selected].isSystem) {
      setMode('delete');
    }

    if (input === 'r') {
      setLoading(true);
      fetchSkills();
    }
  });

  if (loading) {
    return <Text color="yellow">Loading skills...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  // Delete confirmation
  if (mode === 'delete') {
    const skill = skills[selected];
    return (
      <Box flexDirection="column">
        <Text bold underline>Skills</Text>
        <Box marginTop={1}>
          <Text color="red">Delete "{skill?.name}"? (y/n)</Text>
        </Box>
      </Box>
    );
  }

  // Create/edit form
  if (mode === 'create' || mode === 'edit') {
    return (
      <Box flexDirection="column">
        <Text bold underline>{mode === 'create' ? 'Create Skill' : 'Edit Skill'}</Text>
        <Text color="gray">ESC to cancel | Enter to confirm each field</Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={createStep === 'name' ? 'cyan' : 'green'}>
              Name: {formName}{createStep === 'name' ? '█' : ''}
            </Text>
          </Box>
          {(createStep === 'category' || createStep === 'description') && (
            <Box flexDirection="column" marginTop={createStep === 'category' ? 1 : 0}>
              <Text color={createStep === 'category' ? 'cyan' : 'green'}>
                Category: {createStep === 'category' ? '' : formCategory}
              </Text>
              {createStep === 'category' && (
                <Box flexDirection="column" marginLeft={2}>
                  {CATEGORIES.map((cat, i) => (
                    <Text key={cat} color={i === categoryIndex ? 'cyan' : 'gray'}>
                      {i === categoryIndex ? '▸ ' : '  '}{cat}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {createStep === 'description' && (
            <Box marginTop={0}>
              <Text color="cyan">
                Description: {formDescription}█
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  // Detail view
  if (mode === 'detail' && skills[selected]) {
    const skill = skills[selected];
    return (
      <Box flexDirection="column">
        <Text bold underline>Skills</Text>
        <Text color="gray">ESC or Enter to go back</Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">{skill.name}</Text>
          <Text color="gray">Category: {skill.category} | Type: {skill.isSystem ? 'system' : 'custom'}</Text>
          <Text color="white">{skill.description}</Text>

          {skill.principles?.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="yellow">Principles:</Text>
              {skill.principles.map((p, i) => (
                <Text key={i} color="white">  - {p}</Text>
              ))}
            </Box>
          )}

          {skill.bestPractices?.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="green">Best Practices:</Text>
              {skill.bestPractices.map((p, i) => (
                <Text key={i} color="white">  - {p}</Text>
              ))}
            </Box>
          )}

          {skill.antiPatterns?.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="red">Anti-Patterns:</Text>
              {skill.antiPatterns.map((p, i) => (
                <Text key={i} color="white">  - {p}</Text>
              ))}
            </Box>
          )}

          {skill.frameworks?.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="magenta">Frameworks:</Text>
              {skill.frameworks.map((f, i) => (
                <Text key={i} color="white">  - {f}</Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  // List view
  return (
    <Box flexDirection="column">
      <Text bold underline>Skills</Text>
      <Text color="yellow">j/k or ↑↓ navigate | Enter expand | n create | e edit | d delete | r refresh</Text>
      {message && <Text color="cyan">{message}</Text>}

      <Box marginTop={1} flexDirection="column">
        {/* Header */}
        <Box>
          <Box width={3}><Text bold color="gray"> </Text></Box>
          <Box width={24}><Text bold color="gray">Name</Text></Box>
          <Box width={14}><Text bold color="gray">Category</Text></Box>
          <Box width={10}><Text bold color="gray">Type</Text></Box>
          <Box width={8}><Text bold color="gray">Items</Text></Box>
        </Box>

        {skills.length === 0 ? (
          <Box marginTop={1}>
            <Text color="gray">No skills found.</Text>
          </Box>
        ) : (
          skills.map((skill, i) => {
            const isSystem = skill.isSystem;
            const rowColor = isSystem ? 'gray' : 'green';
            return (
              <Box key={skill.id}>
                <Box width={3}>
                  <Text color={i === selected ? 'cyan' : undefined}>
                    {i === selected ? '▸ ' : '  '}
                  </Text>
                </Box>
                <Box width={24}>
                  <Text color={i === selected ? 'cyan' : rowColor} bold={i === selected}>
                    {skill.name.slice(0, 22)}
                  </Text>
                </Box>
                <Box width={14}>
                  <Text color={i === selected ? 'cyan' : rowColor}>
                    {skill.category.slice(0, 12)}
                  </Text>
                </Box>
                <Box width={10}>
                  <Text color={i === selected ? 'cyan' : rowColor}>
                    {isSystem ? 'system' : 'custom'}
                  </Text>
                </Box>
                <Box width={8}>
                  <Text color={i === selected ? 'cyan' : rowColor}>
                    {itemCount(skill)}
                  </Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
